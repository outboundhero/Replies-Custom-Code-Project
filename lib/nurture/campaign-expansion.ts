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
  getCampaignSenderEmails, attachSenderEmails, resumeCampaign,
} from "@/lib/outboundhero-api";
import { logActivity, logError } from "@/lib/errors";
import type { Esp } from "@/lib/nurture/esp";

// "Contacted 50% of the contacts" = total_leads_contacted / total_leads >= 50%.
// (NOT Bison's `completion_percentage`, which is a stricter sequence-completion
// metric — e.g. a 77%-contacted campaign can report completion_percentage ~50.)
export const CONTACTED_MIN = 50;
export const COMBINED_LEADS_MIN = 5000;
const ESPS: Esp[] = ["google", "outlook", "segs"];

/** % of a campaign's contacts that have been contacted. */
function contactedPct(total?: number, contacted?: number): number {
  if (!total || total <= 0) return 0;
  return ((contacted ?? 0) / total) * 100;
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

/** Strip an existing "— Batch N" suffix so batches don't stack in the name. */
function baseName(name: string): string {
  return name.replace(/\s*[—-]\s*batch\s*\d+\s*$/i, "").trim();
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

    row.combinedLeads = details.reduce((s, x) => s + x.total, 0);
    row.allAbove50 = details.every((x) => x.completion >= CONTACTED_MIN);
    const shouldExpand = row.allAbove50 && row.combinedLeads > COMBINED_LEADS_MIN;
    if (!shouldExpand) { row.reason = "below threshold"; result.instances.push(row); continue; }
    if (opts.dryRun) { row.reason = "would expand (dry-run)"; result.instances.push(row); continue; }

    // EXPAND: clone each campaign in the trio.
    const clones: NonNullable<InstanceResult["clones"]> = [];
    for (const x of details) {
      try {
        const clone = await duplicateCampaign(instance, x.entry.campaign_id);
        if (!clone) { await logError("nurture-expand", `${TAG}/${instance}/${x.esp}`, "duplicate returned null"); continue; }
        // Re-attach sender emails (duplicate drops them).
        const senders = await getCampaignSenderEmails(instance, x.entry.campaign_id);
        if (senders.length) await attachSenderEmails(instance, clone.id, senders.map((s) => s.id));
        // Rename to canonical + next batch (markers preserved for detection).
        const n = x.batch + 1;
        const name = `${baseName(x.name)} — Batch ${n}`;
        await updateCampaign(instance, clone.id, { name });
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
