/**
 * Auto-expand nurture campaigns. When a routing's trio (the 3 ESP campaigns —
 * google/outlook/segs — in ONE workspace) is saturated, clone the trio and
 * re-point the routing map to the clones so FUTURE leads flow into the fresh
 * campaigns. Existing leads stay in the old campaigns and keep sending.
 *
 * Trigger per instance-trio: every campaign at completion_percentage >= 50 AND
 * combined total_leads across the 3 > 5,000.
 *
 * Clone = Bison duplicate (carries schedule + sequence + settings) → re-attach
 * sender emails (duplicate drops them) → rename to canonical "… — Batch N" →
 * activate → switch nurture_campaign_map → record + snapshot.
 */
import db from "@/lib/db";
import { getCampaignMap, getMapConfirmedAt, type CampaignMapEntry } from "@/lib/nurture/campaign-map";
import { getChurnedTags } from "@/lib/churn";
import {
  getCampaignDetails, duplicateCampaign, updateCampaign,
  getCampaignSenderEmails, attachSenderEmails, resumeCampaign, getCampaignSchedule,
} from "@/lib/outboundhero-api";
import { logActivity, logError } from "@/lib/errors";
import { detectCampaignEsp, type Esp } from "@/lib/nurture/esp";
import { isFired } from "@/lib/nurture/activation-state";
import { applyOffsetToClone } from "@/lib/nurture/nurture-schedule";
import { listMainCampaigns, type InstanceCampaign } from "@/lib/nurture/campaign-inventory";
import type { BisonInstanceKey } from "@/lib/bison-instances-shared";

// A nurture batch (its 3 ESP campaigns combined) spawns the next batch ONLY when
// it's both genuinely full AND worked through:
//   • >= CONTACTED_LEADS_MIN leads CONTACTED across the trio, AND
//   • >= CONTACTED_MIN_PCT % of the trio's leads contacted.
// This never splits a low-lead batch (e.g. 100 leads at 80% = 80 contacted, well
// under 8,000) and effectively caps each batch around CONTACTED_LEADS_MIN /
// (CONTACTED_MIN_PCT/100) ≈ 10,000 leads before overflowing to a fresh batch.
// (`completion` = total_leads_contacted / total_leads, NOT Bison's
// `completion_percentage`, which is a stricter sequence-completion metric.)
export const CONTACTED_MIN_PCT = 80;
export const CONTACTED_LEADS_MIN = 8000;
const ESPS: Esp[] = ["google", "outlook", "segs"];

/** % of a campaign's contacts that have been contacted. */
function contactedPct(total?: number, contacted?: number): number {
  if (!total || total <= 0) return 0;
  return ((contacted ?? 0) / total) * 100;
}

/**
 * Is a nurture trio ready to spawn the next batch? Combined CONTACTED leads
 * >= CONTACTED_LEADS_MIN AND aggregate contacted % >= CONTACTED_MIN_PCT. Accepts
 * each ESP cell's completion (%) + total leads — the shape both the expander and
 * the monitoring routes already have.
 */
export function trioReadyToExpand(cells: { completion: number; total: number }[]): {
  ready: boolean; combinedContacted: number; combinedTotal: number; pct: number;
} {
  const combinedTotal = cells.reduce((s, c) => s + (c.total || 0), 0);
  const combinedContacted = cells.reduce((s, c) => s + Math.round(((c.completion || 0) / 100) * (c.total || 0)), 0);
  const pct = combinedTotal > 0 ? (combinedContacted / combinedTotal) * 100 : 0;
  const ready = cells.length === 3 && combinedContacted >= CONTACTED_LEADS_MIN && pct >= CONTACTED_MIN_PCT;
  return { ready, combinedContacted, combinedTotal, pct };
}

export interface InstanceResult {
  instance: string;
  trioComplete: boolean;           // all 3 ESP mapped?
  allAbove50: boolean;
  combinedLeads: number;
  expanded: boolean;
  clones?: Array<{ esp: Esp; oldId: number; newId: number; batch: number; name: string }>;
  reason?: string;
  error?: string;
}
export interface ExpansionResult { clientTag: string; instances: InstanceResult[]; error?: string }

/** Highest batch number recorded for a routing (original campaign = batch 1). */
async function currentBatch(tag: string, instance: string, esp: string): Promise<number> {
  const r = await db.execute({
    sql: "SELECT MAX(batch) b FROM nurture_campaign_expansions WHERE UPPER(client_tag)=UPPER(?) AND bison_instance=? AND esp=?",
    args: [tag, instance, esp],
  });
  return Number((r.rows[0] as { b?: number })?.b) || 1;
}

/**
 * Name the next batch by stamping the number INTO the "[Nurture]" marker →
 * "[Nurture N]". Drops any legacy trailing "— Batch N" suffix first so old
 * clones migrate to the new scheme (and batches never stack), and replaces an
 * existing "[Nurture k]" marker so re-expansion bumps the number cleanly.
 * e.g. "JPNNJ: Google [Nurture] (Cleaning Client)" → "… [Nurture 2] (Cleaning Client)".
 */
function nextBatchName(name: string, n: number): string {
  return name
    .replace(/\s*[—-]\s*batch\s*\d+\s*$/i, "")            // drop legacy suffix
    .replace(/\[nurture(?:\s*\d+)?\]/i, `[Nurture ${n}]`) // stamp the marker
    .trim();
}

async function upsertHealth(
  tag: string, instance: string, esp: string,
  c: { id: number; name: string; completion?: number; total?: number; status?: string }, batch: number,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO nurture_routing_health (client_tag, bison_instance, esp, campaign_id, campaign_name, completion_percentage, total_leads, status, batch, checked_at)
          VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
          ON CONFLICT(client_tag, bison_instance, esp) DO UPDATE SET
            campaign_id=excluded.campaign_id, campaign_name=excluded.campaign_name,
            completion_percentage=excluded.completion_percentage, total_leads=excluded.total_leads,
            status=excluded.status, batch=excluded.batch, checked_at=excluded.checked_at`,
    args: [tag.toUpperCase(), instance, esp, c.id, c.name, c.completion ?? 0, c.total ?? 0, c.status ?? "", batch],
  });
}

export async function expandCampaignsForClient(
  clientTag: string,
  opts: { dryRun?: boolean } = {},
): Promise<ExpansionResult> {
  const TAG = clientTag.toUpperCase();
  const result: ExpansionResult = { clientTag: TAG, instances: [] };

  if (!(await getMapConfirmedAt(TAG))) { result.error = "map not confirmed"; return result; }
  if ((await getChurnedTags()).has(TAG)) { result.error = "churned"; return result; }
  const map = await getCampaignMap(TAG);
  if (map.length === 0) { result.error = "no map"; return result; }

  // Expansion gate: the client must be fired (past the 80% MAIN-completion
  // activation gate) — else nurture is paused and shouldn't grow. The per-batch
  // "full + worked-through" test (>=8k contacted & >=80%) is applied per trio
  // below. No time cooldown. (Health snapshots below still run regardless so the
  // monitoring tab stays live.)
  const fired = await isFired(TAG);

  // Matching MAIN schedule for a clone (same instance + ESP, non-draft), so the
  // clone gets the +4h offset from the main — not the inherited nurture schedule.
  // Lazily loaded (only when we actually expand) + cached.
  let mainsCache: InstanceCampaign[] | null = null;
  const mainScheduleCache = new Map<string, Record<string, unknown> | null>();
  const mainScheduleFor = async (instance: BisonInstanceKey, esp: Esp): Promise<Record<string, unknown> | null> => {
    const key = `${instance}:${esp}`;
    if (mainScheduleCache.has(key)) return mainScheduleCache.get(key) ?? null;
    mainsCache ??= await listMainCampaigns(TAG);
    const m = mainsCache.find(
      (mm) => mm.instance === instance && detectCampaignEsp(mm.name) === esp && String(mm.status).toLowerCase() !== "draft",
    );
    const sched = m ? await getCampaignSchedule(instance, m.id) : null;
    mainScheduleCache.set(key, sched);
    return sched;
  };

  // Group mapped entries by instance.
  const byInstance = new Map<string, Map<Esp, CampaignMapEntry>>();
  for (const e of map) {
    if (!byInstance.has(e.bison_instance)) byInstance.set(e.bison_instance, new Map());
    byInstance.get(e.bison_instance)!.set(e.esp, e);
  }

  for (const [instance, espMap] of byInstance) {
    const row: InstanceResult = { instance, trioComplete: false, allAbove50: false, combinedLeads: 0, expanded: false };
    if (ESPS.some((esp) => !espMap.get(esp))) { row.reason = "not all 3 ESP mapped"; result.instances.push(row); continue; }
    row.trioComplete = true;

    // Fetch each mapped campaign's live details + snapshot health (always).
    const details: Array<{ esp: Esp; entry: CampaignMapEntry; completion: number; total: number; name: string; status: string; batch: number }> = [];
    for (const esp of ESPS) {
      const entry = espMap.get(esp)!;
      const d = await getCampaignDetails(instance, entry.campaign_id);
      const batch = await currentBatch(TAG, instance, esp);
      const rec = {
        esp, entry,
        completion: contactedPct(d?.total_leads, d?.total_leads_contacted), // % contacted
        total: d?.total_leads ?? 0,
        name: d?.name ?? entry.campaign_name ?? `${TAG}: ${esp} [Nurture] (Cleaning Client)`,
        status: d?.status ?? "",
        batch,
      };
      if (d) await upsertHealth(TAG, instance, esp, { id: d.id, name: rec.name, completion: rec.completion, total: rec.total, status: rec.status }, batch);
      details.push(rec);
    }

    const gate = trioReadyToExpand(details);
    row.combinedLeads = gate.combinedTotal;
    row.allAbove50 = gate.pct >= CONTACTED_MIN_PCT; // field kept for the monitoring routes; now = aggregate ≥80%
    if (!gate.ready) {
      row.reason = `below threshold (${gate.combinedContacted} contacted, ${gate.pct.toFixed(0)}%; need ≥${CONTACTED_LEADS_MIN} contacted & ≥${CONTACTED_MIN_PCT}%)`;
      result.instances.push(row); continue;
    }
    if (!fired) { row.reason = "not fired (nurture gated off)"; result.instances.push(row); continue; }
    if (opts.dryRun) { row.reason = "would expand (dry-run)"; result.instances.push(row); continue; }

    // EXPAND: clone each campaign in the trio.
    const clones: NonNullable<InstanceResult["clones"]> = [];
    for (const x of details) {
      try {
        const clone = await duplicateCampaign(instance, x.entry.campaign_id);
        if (!clone) { await logError("nurture-expand", `${TAG}/${instance}/${x.esp}`, "duplicate returned null"); continue; }
        // Re-attach sender emails (duplicate drops them). ESP is a lead-routing
        // concept, not a sender-inbox filter — attach all of the client's
        // connected tagged inboxes, mirroring the source campaign.
        const pool = await getCampaignSenderEmails(instance, x.entry.campaign_id);
        const senderIds = pool.filter((s) => s.status.toLowerCase() === "connected").map((s) => s.id);
        if (senderIds.length) await attachSenderEmails(instance, clone.id, senderIds);
        // Rename to canonical + next batch → "[Nurture N]" (still canonical +
        // detected as a batch clone by isBatchTwoPlus).
        const n = x.batch + 1;
        const name = nextBatchName(x.name, n);
        await updateCampaign(instance, clone.id, { name });
        // Set the +4h offset on the clone from its matching MAIN schedule (start
        // +4h, keep main's end) — don't rely on the inherited nurture schedule.
        try {
          const mainSched = await mainScheduleFor(instance as BisonInstanceKey, x.esp);
          if (mainSched) await applyOffsetToClone(instance as BisonInstanceKey, clone.id, mainSched);
        } catch (e) {
          await logError("nurture-expand", `${TAG}/${instance}/${x.esp}/offset`, (e as Error).message);
        }
        // Activate so it sends, then re-point the routing map to the clone.
        await resumeCampaign(instance, clone.id);
        await db.execute({
          sql: "UPDATE nurture_campaign_map SET campaign_id=?, campaign_name=?, updated_at=datetime('now') WHERE UPPER(client_tag)=UPPER(?) AND bison_instance=? AND esp=?",
          args: [clone.id, name, TAG, instance, x.esp],
        });
        await db.execute({
          sql: "INSERT OR REPLACE INTO nurture_campaign_expansions (client_tag, bison_instance, esp, batch, old_campaign_id, new_campaign_id, created_at) VALUES (?,?,?,?,?,?,datetime('now'))",
          args: [TAG, instance, x.esp, n, x.entry.campaign_id, clone.id],
        });
        await upsertHealth(TAG, instance, x.esp, { id: clone.id, name, completion: 0, total: 0, status: "active" }, n);
        clones.push({ esp: x.esp, oldId: x.entry.campaign_id, newId: clone.id, batch: n, name });
      } catch (e) {
        row.error = (e as Error).message;
        await logError("nurture-expand", `${TAG}/${instance}/${x.esp}`, (e as Error).message);
      }
    }
    row.expanded = clones.length > 0;
    row.clones = clones;
    result.instances.push(row);
    if (clones.length) {
      await logActivity("nurture-expand", "expanded", { client_tag: TAG, details: { instance, combinedLeads: row.combinedLeads, clones } });
    }
  }

  return result;
}

/** Clients with a confirmed map (non-churned) — the expansion cron's work-list. */
export async function listExpansionClients(): Promise<string[]> {
  const churned = await getChurnedTags();
  const r = await db.execute(
    `SELECT DISTINCT m.client_tag FROM nurture_campaign_map m
     JOIN client_config c ON UPPER(c.client_tag) = UPPER(m.client_tag)
     WHERE c.nurture_map_confirmed_at IS NOT NULL`,
  );
  return r.rows
    .map((x) => String((x as unknown as { client_tag: string }).client_tag).toUpperCase())
    .filter((t) => !churned.has(t));
}
