/**
 * Auto-map nurture campaigns for active clients.
 *
 * Derives each client's target-campaign map (`nurture_campaign_map`: one canonical
 * campaign per client × bison_instance × ESP) straight from Bison's campaign names,
 * so an operator doesn't have to hand-pick every cell.
 *
 * Rules (operator-confirmed):
 *   • Instance comes from the group sheet (client_groups → getClientInstances).
 *   • A canonical nurture campaign name contains "[Nurture]" AND
 *     "(Cleaning Client)" OR "(Non-Cleaning Client)" — see isCanonicalNurtureCampaign.
 *   • Batch 2+ clones ("… [Nurture N]", or legacy "… — Batch N") are skipped —
 *     only the original "[Nurture]" campaign is mapped.
 *   • GAP-FILL: existing entries are never overwritten (INSERT OR IGNORE), so
 *     re-running only fills newly-available cells for an unconfirmed client.
 *   • CONFIRM: after gap-fill, a client with ≥1 mapped campaign is CONFIRMED
 *     (stamps nurture_map_confirmed_at → enables sending). Partial maps included.
 *   • ALREADY-CONFIRMED clients are left completely untouched (no gap-fill, no
 *     re-confirm), so manual/confirmed choices are preserved.
 */
import db from "@/lib/db";
import supabase from "@/lib/supabase";
import { getCampaignMap, getMapConfirmedAt } from "@/lib/nurture/campaign-map";
import { getAllClientInstances, type ClientInstances } from "@/lib/nurture/group-routing";
import { getChurnedTags } from "@/lib/churn";
import { listCampaigns } from "@/lib/outboundhero-api";
import { detectCampaignEsp, isCanonicalNurtureCampaign, isBatchTwoPlus, type Esp } from "@/lib/nurture/esp";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import { logActivity, logError } from "@/lib/errors";

const ESPS: Esp[] = ["google", "outlook", "segs"];

export interface MappableClient {
  tag: string;
  group: number;
  b2b: string;
  b2c: string;
  mappedSlots?: number; // how many (instance,esp) cells already in the map
  expectedSlots?: number;
}

export interface MapAddition {
  instance: string;
  lane: "b2b" | "b2c";
  esp: Esp;
  campaign_id: number;
  campaign_name: string;
}

export interface AutoMapReport {
  tag: string;
  added: MapAddition[];
  skippedAlreadyMapped: Array<{ instance: string; esp: Esp }>;
  noCandidate: Array<{ instance: string; lane: "b2b" | "b2c"; esp: Esp }>;
  ambiguous: Array<{ instance: string; esp: Esp; chosen: string; choices: string[] }>;
  noGroup?: boolean;
  /** The client's map was already confirmed → left completely untouched. */
  alreadyConfirmed?: boolean;
  /** This run stamped nurture_map_confirmed_at (the map now has ≥1 campaign). */
  confirmed?: boolean;
}

/** A campaign already filtered to canonical / non-batch-2+ / ESP-named, tagged. */
interface CanonicalCampaign {
  id: number;
  name: string;
  status: string;
  total_leads: number;
  esp: Esp;
  tag: string; // UPPER, from the "TAG:" prefix
}

// ── Active mappable clients ──────────────────────────────────────────────────

/**
 * Active clients we may auto-map: in the Turso `client_tags` catalogue AND has a
 * group (so its B2B/B2C instances are known) AND NOT churned AND Supabase
 * `client_status.status === "Active"`. Combined "TAG & TAG2" abbreviations in the
 * status sheet are split the same way as the qualification flow.
 */
export async function getActiveMappableClients(): Promise<MappableClient[]> {
  const [tagsRes, instances, churned, statusRes] = await Promise.all([
    db.execute("SELECT tag FROM client_tags"),
    getAllClientInstances(),
    getChurnedTags(),
    supabase.from("client_status").select("client_abbreviation, status"),
  ]);

  const activeStatus = new Set<string>();
  for (const row of (statusRes.data || []) as Array<{ client_abbreviation: string; status: string }>) {
    if (row.status !== "Active") continue;
    for (const part of String(row.client_abbreviation).split(/\s*[&/,]+\s*/)) {
      const t = part.trim().toUpperCase();
      if (t) activeStatus.add(t);
    }
  }

  const out: MappableClient[] = [];
  const seen = new Set<string>();
  for (const r of tagsRes.rows) {
    const TAG = String((r as unknown as { tag: string }).tag).toUpperCase();
    if (seen.has(TAG)) continue;
    seen.add(TAG);
    if (churned.has(TAG)) continue;
    if (!activeStatus.has(TAG)) continue;
    const inst = instances.get(TAG) as ClientInstances | undefined;
    if (!inst) continue;
    out.push({ tag: TAG, group: inst.group, b2b: inst.b2b, b2c: inst.b2c });
  }
  out.sort((a, b) => a.tag.localeCompare(b.tag));
  return out;
}

/**
 * Annotate each client with how many (instance,esp) cells are already mapped vs
 * the expected count (lane instances × 3 ESPs). One grouped query for the whole
 * map — used by the endpoint's `needsMap` filter so fully-mapped clients are
 * skipped.
 */
export async function annotateMappedSlots(clients: MappableClient[]): Promise<MappableClient[]> {
  const res = await db.execute("SELECT client_tag, bison_instance, esp FROM nurture_campaign_map");
  const byTag = new Map<string, Set<string>>();
  for (const row of res.rows as unknown as Array<{ client_tag: string; bison_instance: string; esp: string }>) {
    const TAG = String(row.client_tag).toUpperCase();
    if (!byTag.has(TAG)) byTag.set(TAG, new Set());
    byTag.get(TAG)!.add(`${row.bison_instance}:${row.esp}`);
  }
  return clients.map((c) => {
    const laneInstances = c.b2c !== c.b2b ? 2 : 1;
    return { ...c, mappedSlots: byTag.get(c.tag)?.size ?? 0, expectedSlots: laneInstances * 3 };
  });
}

// ── Per-instance canonical-campaign cache ────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000;
const campaignCache = new Map<string, { ts: number; campaigns: CanonicalCampaign[] }>();

/**
 * All canonical, non-batch-2+, ESP-named nurture campaigns in an instance, cached
 * per instance (10-min TTL). A burst of per-client auto-map calls therefore only
 * fetches each of the 4 Bison instances once.
 */
export async function listInstanceNurtureCampaignsCached(instance: string): Promise<CanonicalCampaign[]> {
  const hit = campaignCache.get(instance);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.campaigns;

  const all = await listCampaigns(instance);
  const canonical: CanonicalCampaign[] = [];
  for (const c of all) {
    if (!isCanonicalNurtureCampaign(c.name)) continue;
    if (isBatchTwoPlus(c.name)) continue;
    const esp = detectCampaignEsp(c.name);
    if (!esp) continue;
    const tag = (extractTagFromCampaignName(c.name) || "").toUpperCase();
    if (!tag) continue;
    canonical.push({ id: c.id, name: c.name, status: c.status, total_leads: c.total_leads ?? 0, esp, tag });
  }
  campaignCache.set(instance, { ts: Date.now(), campaigns: canonical });
  return canonical;
}

/** Clear the per-instance campaign cache (e.g. for a forced fresh run). */
export function clearAutoMapCache(): void {
  campaignCache.clear();
}

function isLiveStatus(s: string): boolean {
  const x = (s || "").toLowerCase();
  // "queued" = launching/about-to-send — a valid, current campaign (and a far
  // better map target than an archived clone), so it counts as live here.
  return x === "active" || x === "live" || x === "running" || x === "sending" || x === "queued";
}

// ── Per-client auto-map ──────────────────────────────────────────────────────

/**
 * Auto-map one client (gap-fill, draft-only). `instances` is the client's
 * {b2b, b2c} from getClientInstances (null → "no group", reported, no-op).
 */
export async function autoMapClient(
  tag: string,
  instances: { b2b: string; b2c: string } | null,
  opts: { dryRun?: boolean } = {},
): Promise<AutoMapReport> {
  const TAG = tag.toUpperCase();
  const report: AutoMapReport = { tag: TAG, added: [], skippedAlreadyMapped: [], noCandidate: [], ambiguous: [] };
  if (!instances) {
    report.noGroup = true;
    return report;
  }

  // Already confirmed → leave the whole map untouched (no gap-fill, no re-confirm).
  if (await getMapConfirmedAt(TAG)) {
    report.alreadyConfirmed = true;
    return report;
  }

  const existing = await getCampaignMap(TAG);
  const mapped = new Set(existing.map((e) => `${e.bison_instance}:${e.esp}`));

  const lanes: Array<{ instance: string; lane: "b2b" | "b2c" }> = [{ instance: instances.b2b, lane: "b2b" }];
  if (instances.b2c !== instances.b2b) lanes.push({ instance: instances.b2c, lane: "b2c" });

  const toInsert: MapAddition[] = [];
  for (const { instance, lane } of lanes) {
    const forClient = (await listInstanceNurtureCampaignsCached(instance)).filter((c) => c.tag === TAG);
    for (const esp of ESPS) {
      const key = `${instance}:${esp}`;
      if (mapped.has(key)) {
        report.skippedAlreadyMapped.push({ instance, esp });
        continue;
      }
      const candidates = forClient.filter((c) => c.esp === esp);
      if (candidates.length === 0) {
        report.noCandidate.push({ instance, lane, esp });
        continue;
      }
      // Tie-break: prefer a live/active campaign → most leads → lowest id.
      const chosen = [...candidates].sort(
        (a, b) =>
          (isLiveStatus(b.status) ? 1 : 0) - (isLiveStatus(a.status) ? 1 : 0) ||
          b.total_leads - a.total_leads ||
          a.id - b.id,
      )[0];
      if (candidates.length > 1) {
        report.ambiguous.push({ instance, esp, chosen: chosen.name, choices: candidates.map((c) => c.name) });
      }
      const add: MapAddition = { instance, lane, esp, campaign_id: chosen.id, campaign_name: chosen.name };
      toInsert.push(add);
      report.added.push(add);
    }
  }

  if (!opts.dryRun) {
    if (toInsert.length > 0) {
      // INSERT OR IGNORE on the PK (client_tag, bison_instance, esp) — never
      // overwrites an existing entry, so re-runs only gap-fill new cells.
      await db.batch(
        toInsert.map((a) => ({
          sql: `INSERT OR IGNORE INTO nurture_campaign_map (client_tag, bison_instance, esp, campaign_id, campaign_name, lane, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
          args: [TAG, a.instance, a.esp, a.campaign_id, a.campaign_name, a.lane],
        })),
        "write",
      );
    }
    // Confirm the map (enables sending via the route engine / auto-push) as long
    // as it now has ≥1 mapped campaign — partial maps included. Already-confirmed
    // clients returned earlier, so this only ever confirms unconfirmed ones.
    const totalMapped = existing.length + toInsert.length;
    if (totalMapped > 0) {
      await db.batch(
        [
          { sql: "INSERT OR IGNORE INTO client_config (client_tag) VALUES (?)", args: [TAG] },
          { sql: "UPDATE client_config SET nurture_map_confirmed_at = datetime('now'), updated_at = datetime('now') WHERE client_tag = ?", args: [TAG] },
        ],
        "write",
      );
      report.confirmed = true;
    }
  }

  return report;
}

// ── Re-onboarding refresh (already-confirmed clients) ────────────────────────

export interface RefreshReport {
  tag: string;
  checked: number;
  remapped: Array<{ instance: string; esp: Esp; from: { id: number; name: string }; to: { id: number; name: string } }>;
}

/**
 * Re-point an ALREADY-CONFIRMED client's map to its LATEST campaigns — for
 * re-onboarding a returning client whose confirmed map still points at old
 * (paused/archived/removed) campaigns. Rule, kept deliberately conservative so
 * we never fight a live/manual choice:
 *   - a cell is refreshed ONLY when its mapped campaign is NOT live (paused,
 *     archived, or gone) AND a DIFFERENT, LIVE canonical campaign exists for that
 *     (instance, ESP) — i.e. a fresh campaign was created for the returnee.
 *   - a cell whose mapped campaign is still live is left untouched.
 * The operator can always change any cell manually afterward.
 */
export async function refreshMapForClient(
  tag: string,
  instances: { b2b: string; b2c: string } | null,
  opts: { dryRun?: boolean } = {},
): Promise<RefreshReport> {
  const TAG = tag.toUpperCase();
  const report: RefreshReport = { tag: TAG, checked: 0, remapped: [] };
  if (!instances) return report;

  const existing = await getCampaignMap(TAG);
  if (existing.length === 0) return report;

  const byInstance = new Map<string, CanonicalCampaign[]>();
  for (const inst of new Set([instances.b2b, instances.b2c])) {
    byInstance.set(inst, await listInstanceNurtureCampaignsCached(inst));
  }

  for (const cell of existing) {
    report.checked++;
    const list = (byInstance.get(cell.bison_instance) || []).filter((c) => c.tag === TAG && c.esp === cell.esp);
    if (list.length === 0) continue; // no canonical candidates → leave as-is
    const best = [...list].sort(
      (a, b) =>
        (isLiveStatus(b.status) ? 1 : 0) - (isLiveStatus(a.status) ? 1 : 0) ||
        b.total_leads - a.total_leads ||
        a.id - b.id,
    )[0];
    const mapped = list.find((c) => c.id === cell.campaign_id) ?? null;
    const mappedIsLive = mapped ? isLiveStatus(mapped.status) : false;
    if (!mappedIsLive && isLiveStatus(best.status) && best.id !== cell.campaign_id) {
      report.remapped.push({
        instance: cell.bison_instance, esp: cell.esp,
        from: { id: cell.campaign_id, name: cell.campaign_name || "" },
        to: { id: best.id, name: best.name },
      });
      if (!opts.dryRun) {
        await db.execute({
          sql: "UPDATE nurture_campaign_map SET campaign_id = ?, campaign_name = ?, updated_at = datetime('now') WHERE client_tag = ? AND bison_instance = ? AND esp = ?",
          args: [best.id, best.name, TAG, cell.bison_instance, cell.esp],
        });
      }
    }
  }
  if (!opts.dryRun && report.remapped.length > 0) {
    await logActivity("nurture-auto-map", "remapped-to-latest", { client_tag: TAG, details: { remapped: report.remapped } });
  }
  return report;
}

// ── Scheduled sweep: auto-map new clients + refresh returnees ────────────────

let _automapCursorReady: Promise<void> | null = null;
function ensureAutomapCursor(): Promise<void> {
  if (!_automapCursorReady) {
    _automapCursorReady = db.execute(
      "CREATE TABLE IF NOT EXISTS nurture_automap_cursor (client_tag TEXT PRIMARY KEY, last_run_at TEXT)",
    ).then(() => undefined).catch((e) => { _automapCursorReady = null; throw e; });
  }
  return _automapCursorReady;
}

export interface AutoMapSweepResult {
  checked: number;
  budgetHit: boolean;
  newlyMapped: Array<{ tag: string; added: number; confirmed: boolean }>;
  remapped: Array<{ tag: string; cells: number }>;
}

/**
 * Sweep active mappable clients, least-recently-run first, within a time budget:
 *   - UNCONFIRMED client → autoMapClient (map its 3 nurture campaigns + confirm →
 *     enables sending). This makes new-client mapping fully automatic.
 *   - CONFIRMED client → refreshMapForClient (re-point stale cells to the latest
 *     live campaigns → handles re-onboarding a returning client).
 */
export async function runAutoMapSweep(opts: { dryRun?: boolean; limit?: number; maxMs?: number } = {}): Promise<AutoMapSweepResult> {
  await ensureAutomapCursor();
  const dry = !!opts.dryRun;
  const started = Date.now();
  const budgetMs = opts.maxMs ?? 240_000;
  const res: AutoMapSweepResult = { checked: 0, budgetHit: false, newlyMapped: [], remapped: [] };

  const clients = await getActiveMappableClients();
  const byTag = new Map(clients.map((c) => [c.tag, c]));

  const cur = await db.execute("SELECT client_tag, last_run_at FROM nurture_automap_cursor");
  const last = new Map<string, string>();
  for (const r of cur.rows as unknown as Array<{ client_tag: string; last_run_at: string }>) last.set(String(r.client_tag).toUpperCase(), r.last_run_at || "");
  let tags = clients.map((c) => c.tag);
  tags.sort((a, b) => (last.get(a) ?? "").localeCompare(last.get(b) ?? ""));
  if (opts.limit && opts.limit > 0) tags = tags.slice(0, opts.limit);

  for (const tag of tags) {
    if (Date.now() - started > budgetMs) { res.budgetHit = true; break; }
    const c = byTag.get(tag)!;
    const instances = { b2b: c.b2b, b2c: c.b2c };
    try {
      if (await getMapConfirmedAt(tag)) {
        const rr = await refreshMapForClient(tag, instances, { dryRun: dry });
        if (rr.remapped.length) res.remapped.push({ tag, cells: rr.remapped.length });
      } else {
        const mr = await autoMapClient(tag, instances, { dryRun: dry });
        if (mr.added.length || mr.confirmed) res.newlyMapped.push({ tag, added: mr.added.length, confirmed: !!mr.confirmed });
      }
    } catch (e) {
      await logError("nurture-auto-map", `${tag}/sweep`, (e as Error).message);
    }
    res.checked++;
    if (!dry) {
      await db.execute({
        sql: "INSERT INTO nurture_automap_cursor (client_tag, last_run_at) VALUES (?, datetime('now')) ON CONFLICT(client_tag) DO UPDATE SET last_run_at = datetime('now')",
        args: [tag],
      });
    }
  }
  return res;
}
