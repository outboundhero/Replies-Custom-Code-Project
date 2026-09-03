/**
 * Stopped-lead recovery — re-nurture leads that Bison marked `sequence_stopped`
 * (stop reasons "Unknown" or "Associated sender being deleted/moved", per the
 * campaign UI; the reason itself is NOT exposed by the API, so we recover the
 * whole stopped set minus the ones we must not touch).
 *
 * It is a NEW SOURCE into the same verified routing engine the finished-lead
 * flow uses (`routeCandidates`): pull a client's stopped leads → dedupe by email
 * → drop blacklisted / bounced / replied / sheet-Meeting-Ready / already-
 * recovered → route into the confirmed nurture map (create-in-target + attach) →
 * STAMP each recovered email in `nurture_stopped_recovered`.
 *
 * IDEMPOTENCY (the client's core requirement — never re-add the same lead):
 *   - own ledger `nurture_stopped_recovered(client_tag,email)` with `added_at`
 *     stamped only after a successful attach; a candidate already stamped is
 *     filtered out before routing, so a re-run / the ongoing cron never re-adds.
 *   - ESP from the SOURCE campaign name (same as route-from-campaign).
 *   - a `dry` mode computes every count WITHOUT touching Bison or the ledger —
 *     this is the dry-run the operator approves before the live backfill.
 *
 * Scope is controlled by `statuses`: the ONGOING cron passes live statuses
 * (active/paused); the one-time BACKFILL passes archived-inclusive so stranded
 * pools (campaigns archived by the nurture merge) are swept once.
 */
import db from "@/lib/db";
import { listCampaigns, sweepCampaignLeadsCursor, type OutboundLead } from "@/lib/outboundhero-api";
import { getChurnedTags } from "@/lib/churn";
import { getAllClientInstances, getClientInstances } from "@/lib/nurture/group-routing";
import { getCampaignMap, getMapConfirmedAt } from "@/lib/nurture/campaign-map";
import { detectCampaignEsp, isCanonicalNurtureCampaign } from "@/lib/nurture/esp";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import { isPersonalDomain } from "@/lib/processing/personal-domains";
import { routeCandidates, type Candidate } from "@/lib/nurture/route-candidates";
import { getSheetMeetingReadyEmails } from "@/lib/nurture/sheet-meeting-ready";
import { logActivity, logError } from "@/lib/errors";

const ALL_INSTANCES = ["outboundhero", "outboundclean", "cleaningoutbound", "facilityreach"];
const LIVE_STATUSES = ["active", "paused"];
const BACKFILL_STATUSES = ["active", "paused", "completed", "stopped", "archived"];

// ── ledger table ─────────────────────────────────────────────────────────────
let ready: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await db.execute(
        `CREATE TABLE IF NOT EXISTS nurture_stopped_recovered (
           client_tag TEXT NOT NULL,
           email TEXT NOT NULL,
           ob_lead_id INTEGER,
           bison_instance TEXT,
           esp TEXT,
           nurture_campaign_id INTEGER,
           added_at TEXT,
           created_at TEXT DEFAULT (datetime('now')),
           PRIMARY KEY (client_tag, email)
         )`,
      );
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function loadRecovered(tag: string): Promise<Set<string>> {
  const r = await db.execute({
    sql: "SELECT email FROM nurture_stopped_recovered WHERE client_tag = ? AND added_at IS NOT NULL",
    args: [tag],
  });
  const s = new Set<string>();
  for (const row of r.rows as unknown as Array<{ email: string }>) s.add(String(row.email).toLowerCase());
  return s;
}

async function stampRecovered(
  tag: string,
  campaignId: number,
  rows: Array<{ email: string; obLeadId: number | null; sourceInstance: string | null; esp: string }>,
): Promise<void> {
  const stamp = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const placeholders = chunk.map(() => "(?,?,?,?,?,?,?)").join(",");
    const args = chunk.flatMap((r) => [
      tag, r.email.toLowerCase(), r.obLeadId, r.sourceInstance, r.esp, campaignId, stamp,
    ]);
    await db.execute({
      sql: `INSERT INTO nurture_stopped_recovered
              (client_tag, email, ob_lead_id, bison_instance, esp, nurture_campaign_id, added_at)
            VALUES ${placeholders}
            ON CONFLICT(client_tag, email) DO UPDATE SET
              added_at = excluded.added_at,
              nurture_campaign_id = excluded.nurture_campaign_id`,
      args,
    });
  }
}

// NOTE on blacklisted leads: we deliberately do NOT fetch/exclude the blacklist.
// Bison's blacklist endpoint serves ~15 rows/page and the lists run to hundreds
// of thousands of emails (outboundhero alone ~338k = 22k+ pages), so fetching it
// is infeasible. It's also unnecessary: a blacklisted address attached to a
// campaign is SUPPRESSED at send time by Bison — it never receives an email. So
// re-adding one is harmless; Bison enforces the block. (Matches MikeBison's
// "de-blacklist before re-adding" — without de-blacklisting, they just don't send.)

function isBounced(l: OutboundLead): boolean {
  if (String(l.status || "").toLowerCase().includes("bounce")) return true;
  const lcd = l.lead_campaign_data as unknown as Array<{ status?: string }> | { status?: string } | undefined;
  if (Array.isArray(lcd)) return lcd.some((x) => String(x?.status || "").toLowerCase().includes("bounce"));
  return String(lcd?.status || "").toLowerCase().includes("bounce");
}
function repliedCount(l: OutboundLead): number {
  return Number(l.overall_stats?.replies ?? 0) || 0;
}

// ── result shape ─────────────────────────────────────────────────────────────
export interface RecoverResult {
  clientTag: string;
  dry: boolean;
  ok: boolean;
  error?: string;
  noMap?: boolean;
  campaignsScanned: number;
  grossStopped: number;              // every stopped lead-row seen (pre-dedup)
  uniqueStopped: number;             // distinct emails
  excludedBlacklisted: number;
  excludedBounced: number;
  excludedReplied: number;
  excludedAlreadyRecovered: number;
  excludedSheetMeetingReady: number;
  eligible: number;                  // net that would be routed (dry) / attempted (live)
  attached: number;                  // live: actually attached to a nurture campaign
  unmapped: number;                  // eligible but no mapped campaign for their bucket
  budgetHit?: boolean;               // stopped early on cap/time budget (more remain)
}

function emptyResult(tag: string, dry: boolean): RecoverResult {
  return {
    clientTag: tag, dry, ok: false, campaignsScanned: 0, grossStopped: 0, uniqueStopped: 0,
    excludedBlacklisted: 0, excludedBounced: 0, excludedReplied: 0, excludedAlreadyRecovered: 0,
    excludedSheetMeetingReady: 0, eligible: 0, attached: 0, unmapped: 0,
  };
}

/**
 * Recover one client's stopped leads. `dry` computes counts without mutating.
 * `statuses` selects live vs. archived-inclusive campaign scope. `cap` bounds how
 * many candidate leads we route this call (the cron's per-run safety budget).
 */
export async function recoverStoppedForClient(
  tag: string,
  opts: { dry?: boolean; statuses?: string[]; cap?: number; maxMs?: number; onFlush?: (r: RecoverResult) => void } = {},
): Promise<RecoverResult> {
  const TAG = tag.toUpperCase();
  const dry = !!opts.dry;
  const statuses = opts.statuses ?? LIVE_STATUSES;
  const cap = opts.cap ?? 100000;
  const res = emptyResult(TAG, dry);

  await ensureTable();

  // Gates — identical to the finished-lead flow.
  if (!(await getMapConfirmedAt(TAG))) { res.error = "map not confirmed"; res.noMap = true; return res; }
  if ((await getChurnedTags()).has(TAG)) { res.error = "churned"; return res; }
  const instances = await getClientInstances(TAG);
  if (!instances) { res.error = "no group mapping"; return res; }
  const map = await getCampaignMap(TAG);
  if (map.length === 0) { res.error = "no campaigns mapped"; res.noMap = true; return res; }

  // Source campaigns: the client's own ESP-named, non-nurture campaigns with leads.
  const instanceKeys = Array.from(new Set([instances.b2b, instances.b2c]));
  const sources: Array<{ inst: string; id: number; esp: "google" | "outlook" | "segs" }> = [];
  for (const inst of instanceKeys) {
    let list;
    try { list = await listCampaigns(inst, { statuses, search: TAG }); }
    catch (e) { await logError("nurture-recover-stopped", `${TAG}/${inst}/list`, (e as Error).message); continue; }
    for (const c of list) {
      const name = c.name || "";
      if ((extractTagFromCampaignName(name) || "").toUpperCase() !== TAG) continue;
      if (isCanonicalNurtureCampaign(name)) continue;
      const esp = detectCampaignEsp(name);
      if (!esp) continue;
      if ((c.total_leads ?? 0) === 0) continue;
      sources.push({ inst, id: c.id, esp });
    }
  }
  res.campaignsScanned = sources.length;
  if (sources.length === 0) { res.ok = true; return res; }

  const recovered = await loadRecovered(TAG);

  // Sheet-authoritative Meeting-Ready gate emails (once; fail CLOSED if the sheet
  // is registered but unreadable — never risk re-nurturing a delivered lead).
  const smr = await getSheetMeetingReadyEmails(TAG);
  if (!smr.ok) { res.error = "lead-tracking sheet unreadable — skipped (fail-closed)"; return res; }

  // STREAM: page each source campaign in windows → route + stamp every FLUSH
  // leads. The ledger fills incrementally, so progress persists and a crash/stop
  // never loses more than the last window (resumable via the ledger). `cap` and
  // `maxMs` bound one call; whatever's left is picked up on the next run.
  const started = Date.now();
  const maxMs = opts.maxMs ?? Infinity;
  const FLUSH = 500;
  const seen = new Set<string>();           // distinct stopped emails handled this run
  let buffer: Candidate[] = [];

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const batch = buffer; buffer = [];
    res.eligible += batch.length;
    if (dry) return;                          // dry: count only, no Bison/ledger writes
    const routed = await routeCandidates(TAG, batch, map, {
      onAttached: async (campaignId, resolvedList) => {
        await stampRecovered(
          TAG, campaignId,
          resolvedList.map((c) => ({ email: c.email, obLeadId: c.obLeadId, sourceInstance: c.sourceInstance, esp: c.esp })),
        );
      },
    });
    res.attached += routed.totalAttached;
    res.unmapped += routed.perBucket.filter((b) => b.error?.includes("no campaign mapped")).reduce((n, b) => n + b.requested, 0);
    opts.onFlush?.({ ...res });
  };

  outer:
  for (const s of sources) {
    let cursor: string | null = null;
    for (;;) {
      if (Date.now() - started > maxMs || res.eligible + buffer.length >= cap) { res.budgetHit = true; break outer; }
      let win: { leads: OutboundLead[]; nextCursor: string | null; done: boolean };
      try {
        win = await sweepCampaignLeadsCursor(s.inst, s.id, cursor, {
          leadCampaignStatus: "sequence_stopped", maxLeads: FLUSH, maxMs: 60_000,
        });
      } catch (e) {
        await logError("nurture-recover-stopped", `${TAG}/${s.inst}/${s.id}/sweep`, (e as Error).message);
        break;
      }
      for (const l of win.leads) {
        res.grossStopped++;
        const email = String(l.email || "").toLowerCase().trim();
        if (!email || seen.has(email)) continue;   // dedupe across campaigns
        seen.add(email);
        if (isBounced(l)) { res.excludedBounced++; continue; }
        if (repliedCount(l) > 0) { res.excludedReplied++; continue; }
        if (recovered.has(email)) { res.excludedAlreadyRecovered++; continue; }
        if (smr.emails.size && smr.emails.has(email)) { res.excludedSheetMeetingReady++; continue; }
        const lane: "b2b" | "b2c" = isPersonalDomain(email) ? "b2c" : "b2b";
        buffer.push({
          source: "campaign", rowId: l.id, email, esp: s.esp,
          first_name: l.first_name ?? null, last_name: l.last_name ?? null, company: l.company ?? null,
          obLeadId: l.id, sourceInstance: s.inst,
          custom_variables: Array.isArray(l.custom_variables)
            ? l.custom_variables.filter((v) => v && v.name && v.value != null) : [],
          lane, instance: instances[lane],
        });
        if (buffer.length >= FLUSH) await flush();
      }
      if (win.done || !win.nextCursor) break;
      cursor = win.nextCursor;
    }
  }
  await flush();
  res.uniqueStopped = seen.size;
  res.ok = true;

  await logActivity("nurture-recover-stopped", res.attached > 0 ? "recovered" : "no-op", {
    client_tag: TAG,
    details: {
      campaigns: res.campaignsScanned, unique_stopped: res.uniqueStopped, eligible: res.eligible,
      attached: res.attached, bounced: res.excludedBounced, replied: res.excludedReplied,
      already_recovered: res.excludedAlreadyRecovered, sheet_meeting_ready: res.excludedSheetMeetingReady,
      budget_hit: res.budgetHit ?? false,
    },
  });
  return res;
}

/** Every eligible (active, non-churned) client tag. */
export async function listEligibleClients(): Promise<string[]> {
  const all = await getAllClientInstances();
  const churned = await getChurnedTags();
  return [...all.keys()].map((t) => t.toUpperCase()).filter((t) => !churned.has(t)).sort();
}

// ── rotation cursor (ongoing cron: least-recently-run first) ──────────────────
let cursorReady: Promise<void> | null = null;
function ensureCursor(): Promise<void> {
  if (!cursorReady) {
    cursorReady = db.execute(
      "CREATE TABLE IF NOT EXISTS nurture_recover_cursor (client_tag TEXT PRIMARY KEY, last_run_at TEXT)",
    ).then(() => undefined).catch((e) => { cursorReady = null; throw e; });
  }
  return cursorReady;
}

export interface SweepResult {
  checked: number;
  budgetHit: boolean;
  results: RecoverResult[];
}

/**
 * Sweep eligible clients, least-recently-run first, within a soft time budget.
 * `backfill` widens scope to archived campaigns (the one-time pass); the ongoing
 * cron leaves it off (active/paused only). `dry` computes without mutating.
 */
export async function runRecoverStoppedSweep(opts: {
  dry?: boolean;
  backfill?: boolean;
  limit?: number;
  maxMs?: number;
  capPerClient?: number;
} = {}): Promise<SweepResult> {
  await ensureTable();
  await ensureCursor();
  const dry = !!opts.dry;
  const statuses = opts.backfill ? BACKFILL_STATUSES : LIVE_STATUSES;
  const started = Date.now();
  const budgetMs = opts.maxMs ?? 270_000;

  let tags = await listEligibleClients();
  // Order least-recently-run first so each tick advances a different slice.
  const cur = await db.execute("SELECT client_tag, last_run_at FROM nurture_recover_cursor");
  const last = new Map<string, string>();
  for (const r of cur.rows as unknown as Array<{ client_tag: string; last_run_at: string }>) {
    last.set(String(r.client_tag).toUpperCase(), r.last_run_at || "");
  }
  tags.sort((a, b) => (last.get(a) ?? "").localeCompare(last.get(b) ?? ""));
  if (opts.limit && opts.limit > 0) tags = tags.slice(0, opts.limit);

  const results: RecoverResult[] = [];
  let budgetHit = false;
  for (const tag of tags) {
    if (Date.now() - started > budgetMs) { budgetHit = true; break; }
    const r = await recoverStoppedForClient(tag, { dry, statuses, cap: opts.capPerClient });
    results.push(r);
    if (!dry) {
      await db.execute({
        sql: "INSERT INTO nurture_recover_cursor (client_tag, last_run_at) VALUES (?, datetime('now')) ON CONFLICT(client_tag) DO UPDATE SET last_run_at = datetime('now')",
        args: [tag],
      });
    }
  }
  return { checked: results.length, budgetHit, results };
}

export { LIVE_STATUSES, BACKFILL_STATUSES, ALL_INSTANCES };
