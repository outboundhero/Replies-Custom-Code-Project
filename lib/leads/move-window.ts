/**
 * Lead Mover — the per-window engine, extracted from the two move routes so BOTH
 * the HTTP routes (thin wrappers) and the server-side job runner call the SAME
 * idempotent window logic (no duplication of the service-area/lane/ESP/route
 * pipeline). Each call cursor-sweeps a bounded WINDOW of a source campaign's
 * leads, routes them into the destination(s), and returns `{…, nextCursor, done}`.
 * The caller re-invokes with `nextCursor` until `done`.
 *
 * Idempotent: createLeadsInInstance upserts by email, attach treats "already
 * present" as success, lead_move_log uses INSERT OR IGNORE, lead_move_skipped
 * uses INSERT OR REPLACE — so re-running a window (after an interruption) never
 * double-moves. `error` is set ONLY on a hard failure (fetch failed with nothing
 * fetched, or a chunk that threw — then `nextCursor` is that chunk's START, so it's
 * done again, never skipped); a mid-window read error with partial progress returns
 * the current cursor with no error so the caller resumes. Leads Bison refused one by
 * one come back in `failed` (with the reason) for the caller to record and retry.
 */
import db from "@/lib/db";
import { sweepCampaignLeadsCursor, findLeadByEmail, type OutboundLead } from "@/lib/outboundhero-api";
import { routeCandidates, type Candidate, type RouteCandidatesResult } from "@/lib/nurture/route-candidates";
import { detectCampaignEsp, bucketEsp, detectEsp, pickEspFromTags, type Esp } from "@/lib/nurture/esp";
import { type CampaignMapEntry } from "@/lib/nurture/campaign-map";
import { getInstanceLane } from "@/lib/bison-instances-shared";
import { isPersonalDomain } from "@/lib/processing/personal-domains";
import { getServiceArea, cityInServiceArea, cityFromCustomVars, stateFromCustomVars } from "@/lib/service-area";

const ESPS: Esp[] = ["google", "outlook", "segs"];
const LANES = ["b2b", "b2c"] as const;
type Lane = (typeof LANES)[number];
type CrossDest = Partial<Record<Esp, number>>;
type SameDest = { b2b: Partial<Record<Esp, number>>; b2c: Partial<Record<Esp, number>> };

// Default per-call budgets — match the original routes. The runner passes a
// SMALLER windowMs so it can cycle many tasks under its own deadline.
const DEFAULT_CROSS_WINDOW_MS = 170_000; // < maxDuration 300
const DEFAULT_SAME_WINDOW_MS = 230_000;

async function parallelForEach<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

// ── Service-area skip log (shared) ───────────────────────────────────────────
interface SkipCtx { runId: string | null; clientTag: string; sourceInstance: string; sourceCampaignId: number; sourceCampaignName: string; targetInstance: string }

async function persistSkipped(leads: OutboundLead[], ctx: SkipCtx) {
  const nowIso = new Date().toISOString();
  const COLS = 16;
  for (let i = 0; i < leads.length; i += 200) {
    const chunk = leads.slice(i, i + 200);
    const ph = chunk.map(() => `(${Array(COLS).fill("?").join(",")})`).join(",");
    const args = chunk.flatMap((l) => {
      const city = cityFromCustomVars(l.custom_variables);
      const state = stateFromCustomVars(l.custom_variables);
      return [
        ctx.runId, ctx.clientTag, ctx.sourceInstance, ctx.sourceCampaignId, ctx.sourceCampaignName, ctx.targetInstance,
        l.id, l.email ?? null, l.first_name ?? null, l.last_name ?? null, l.company ?? null,
        city, state, `out of service area${city ? ` (city: ${city})` : ""}`,
        JSON.stringify(Array.isArray(l.custom_variables) ? l.custom_variables : []), nowIso,
      ];
    });
    try {
      await db.execute({
        sql: `INSERT OR REPLACE INTO lead_move_skipped
          (run_id, client_tag, source_instance, source_campaign_id, source_campaign_name, target_instance,
           ob_lead_id, email, first_name, last_name, company, city, state, reason, custom_variables, skipped_at)
          VALUES ${ph}`,
        args,
      });
    } catch { /* audit only — never fail the move on a skip-log write */ }
  }
}

async function logMoved(clientTag: string, sourceInstance: string, sourceCampaignId: number, targetInstance: string, campaignId: number, resolved: Array<{ obLeadId?: unknown; email: string }>, nowIso: string) {
  const rows = resolved.filter((r) => typeof r.obLeadId === "number") as Array<{ obLeadId: number; email: string }>;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const ph = chunk.map(() => "(?,?,?,?,?,?,?,?)").join(",");
    const args = chunk.flatMap((r) => [clientTag, sourceInstance, sourceCampaignId, targetInstance, campaignId, r.obLeadId, r.email, nowIso]);
    try {
      await db.execute({
        sql: `INSERT OR IGNORE INTO lead_move_log
          (client_tag, source_instance, source_campaign_id, target_instance, target_campaign_id, ob_lead_id, email, moved_at)
          VALUES ${ph}`,
        args,
      });
    } catch { /* audit only — never fail the move on a log write */ }
  }
}

// ── Each lead's ESP (shared) ─────────────────────────────────────────────────

/**
 * Each lead's ESP from its Bison ESP tag (Bison's campaign lead list doesn't carry tags, so each lead is looked up).
 * A lead without an ESP tag goes by its email domain. A lookup that fails (Bison busy — rate limit) gets one more
 * try after a pause; one that fails twice also goes by its domain, and is counted (`guessed`) so it shows on the job.
 */
async function resolveEsps(instance: string, leads: OutboundLead[], campaignEsp: Esp | null): Promise<{ espByEmail: Map<string, Esp>; guessed: number }> {
  const espByEmail = new Map<string, Esp>();
  if (campaignEsp) {
    for (const l of leads) espByEmail.set(l.email, campaignEsp);
    return { espByEmail, guessed: 0 };
  }
  const missed: OutboundLead[] = [];
  const look = async (l: OutboundLead): Promise<boolean> => {
    try {
      const full = await findLeadByEmail(instance, l.email);
      if (!full) return false;
      const tag = pickEspFromTags(full.tags);
      espByEmail.set(l.email, tag ? bucketEsp(tag) : detectEsp(l.email));
      return true;
    } catch { return false; }
  };
  await parallelForEach(leads, 8, async (l) => { if (!(await look(l))) missed.push(l); });
  let guessed = 0;
  if (missed.length) {
    await new Promise((r) => setTimeout(r, 1500));
    for (const l of missed) {
      if (await look(l)) continue;
      espByEmail.set(l.email, detectEsp(l.email));
      guessed++;
    }
  }
  return { espByEmail, guessed };
}

// ── Failed leads (shared) ────────────────────────────────────────────────────

/** A lead that didn't reach its campaign — kept with everything needed to send it again. */
export interface FailedLead { obLeadId: number; email: string; reason: string; campaignId: number; retryable: boolean; candidate: Candidate }

/** Below this many leads, a chunk where every lead failed is still read as per-lead trouble, not Bison being down. */
const WHOLE_CHUNK_FAIL_MIN = 20;

/**
 * routeCandidates' failures → FailedLead[]. A request that failed as a whole (Bison error, dropped connection —
 * `batch`), or EVERY candidate of a chunk failing (and enough of them), is Bison or the connection failing, not
 * the leads: that throws, so the window stops at this chunk and the runner does it again (a campaign that keeps
 * failing ends up failed, with the reason) — instead of filing a campaign's leads as errors one by one.
 */
function toFailed(rc: RouteCandidatesResult, candidates: number): FailedLead[] {
  const batch = rc.failed.find((f) => f.batch);
  if (batch) throw new Error(batch.reason);
  const failed = rc.failed.map((f) => ({
    obLeadId: Number(f.candidate.obLeadId ?? f.candidate.rowId), email: f.candidate.email, reason: f.reason,
    campaignId: f.campaignId, retryable: f.retryable, candidate: f.candidate,
  }));
  const retryable = failed.filter((f) => f.retryable).length;
  if (retryable >= WHOLE_CHUNK_FAIL_MIN && retryable === candidates - (rc.suppressedExcluded ?? 0)) {
    throw new Error(`every lead in this batch failed — ${failed[0].reason}`);
  }
  return failed;
}

// ── Cross-instance window ────────────────────────────────────────────────────

export interface MoveCrossParams {
  runId: string | null;
  clientTag: string;
  sourceInstance: string;
  sourceCampaignId: number;
  sourceCampaignName: string;
  targetInstance: string;
  dest: CrossDest;
  serviceAreaFilter: boolean;
  cursor: string | null;
  windowMs?: number;
  windowLeads?: number;
  subWindow?: number;
}
/**
 * Every lead `processed` (read AND handled) is exactly one of: moved, skippedArea, skippedLane, skippedNoDest,
 * noEmail, suppressed or failed. `fetched` counts reads, including a chunk that wasn't handled.
 */
export interface MoveCrossResult {
  fetched: number; processed: number; moved: number; movedByKey: Record<string, number>;
  skippedArea: number; skippedLane: number; skippedNoDest: number; noEmail: number; suppressed: number;
  /** Routed by email domain because Bison didn't answer their ESP lookup (twice). */
  espGuessed: number;
  failed: FailedLead[];
  nextCursor: string | null; done: boolean; error?: string;
}

interface CrossCtx {
  runId: string | null; clientTag: string; sourceInstance: string; sourceCampaignId: number; sourceCampaignName: string;
  targetInstance: string; targetLane: Lane; dest: CrossDest; campaignEsp: Esp | null; needsLookup: boolean;
  area: Awaited<ReturnType<typeof getServiceArea>>;
}

export async function moveCrossWindow(p: MoveCrossParams): Promise<MoveCrossResult> {
  const targetLane = getInstanceLane(p.targetInstance);
  const campaignEsp = detectCampaignEsp(p.sourceCampaignName);
  const needsLookup = true; // always resolve each lead's ESP from its real Bison tag
  const area = p.serviceAreaFilter ? await getServiceArea(p.clientTag) : null;
  const ctx: CrossCtx = {
    runId: p.runId, clientTag: p.clientTag, sourceInstance: p.sourceInstance, sourceCampaignId: p.sourceCampaignId,
    sourceCampaignName: p.sourceCampaignName, targetInstance: p.targetInstance, targetLane, dest: p.dest, campaignEsp, needsLookup, area,
  };

  const WINDOW = p.windowLeads ?? (needsLookup ? 800 : 2500);
  const SUB_WINDOW = p.subWindow ?? (needsLookup ? 400 : 800);
  const WINDOW_MS = p.windowMs ?? DEFAULT_CROSS_WINDOW_MS;

  const t = { processed: 0, moved: 0, skippedArea: 0, skippedLane: 0, skippedNoDest: 0, noEmail: 0, suppressed: 0, espGuessed: 0 };
  const movedByKey: Record<string, number> = {};
  const failed: FailedLead[] = [];
  let fetched = 0;
  let cursor: string | null = p.cursor;
  let done = false;
  // A chunk that throws stops the window at that chunk's START, so it's done again (never skipped).
  const w: { error: Error | null; at: string | null } = { error: null, at: null };
  let writeChain: Promise<void> = Promise.resolve();
  const deadline = Date.now() + WINDOW_MS;
  const out = (nextCursor: string | null, isDone: boolean, error?: string): MoveCrossResult =>
    ({ fetched, ...t, movedByKey, failed, nextCursor, done: isDone, ...(error ? { error } : {}) });

  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const chunkStart = cursor;
    let s: { leads: OutboundLead[]; nextCursor: string | null; done: boolean };
    try {
      s = await sweepCampaignLeadsCursor(p.sourceInstance, p.sourceCampaignId, cursor, { maxLeads: SUB_WINDOW, maxMs: Math.min(remainingMs, 60_000) });
    } catch (e) {
      await writeChain;
      if (w.error) return out(w.at, false, `move failed: ${w.error.message}`);
      if (fetched === 0) return out(cursor, false, `fetch failed: ${(e as Error).message}`);
      return out(cursor, false); // partial → resume
    }
    fetched += s.leads.length;
    cursor = s.nextCursor;
    done = s.done;

    const chunk = s.leads;
    const prev = writeChain;
    writeChain = (async () => {
      await prev;
      if (w.error) return;
      try {
        const r = await routeAndLog(chunk, ctx);
        t.moved += r.moved; t.skippedArea += r.skippedArea; t.skippedLane += r.skippedLane; t.skippedNoDest += r.skippedNoDest;
        t.noEmail += r.noEmail; t.suppressed += r.suppressed; t.espGuessed += r.espGuessed;
        for (const [k, n] of Object.entries(r.movedByKey)) movedByKey[k] = (movedByKey[k] || 0) + n;
        failed.push(...r.failed);
        t.processed += chunk.length;
      } catch (e) { w.error = e as Error; w.at = chunkStart; }
    })();

    if (done || !cursor || fetched >= WINDOW) break;
  }

  await writeChain;
  if (w.error) return out(w.at, false, `move failed: ${w.error.message}`);
  return out(done ? null : cursor, done);
}

interface CrossChunk { moved: number; movedByKey: Record<string, number>; skippedArea: number; skippedLane: number; skippedNoDest: number; noEmail: number; suppressed: number; espGuessed: number; failed: FailedLead[] }

async function routeAndLog(leads: OutboundLead[], ctx: CrossCtx): Promise<CrossChunk> {
  let gated = leads;
  let skippedArea = 0;
  if (ctx.area) {
    const inArea: OutboundLead[] = [];
    const outArea: OutboundLead[] = [];
    for (const l of leads) {
      const city = cityFromCustomVars(l.custom_variables);
      if (city && !cityInServiceArea(city, ctx.area.tokens)) outArea.push(l);
      else inArea.push(l);
    }
    if (outArea.length) { await persistSkipped(outArea, { ...ctx }); skippedArea += outArea.length; }
    gated = inArea;
  }

  const laneMatched: OutboundLead[] = [];
  let skippedLane = 0;
  for (const l of gated) {
    const lane = isPersonalDomain(l.email) ? "b2c" : "b2b";
    if (lane === ctx.targetLane) laneMatched.push(l);
    else skippedLane++;
  }
  const withEmail = laneMatched.filter((l) => (l.email || "").trim());
  const noEmail = laneMatched.length - withEmail.length;

  const { espByEmail, guessed: espGuessed } = await resolveEsps(ctx.sourceInstance, withEmail, ctx.needsLookup ? null : ctx.campaignEsp);

  const candidates: Candidate[] = [];
  let skippedNoDest = 0;
  const usedEsps = new Set<Esp>();
  for (const l of withEmail) {
    const esp = espByEmail.get(l.email) || "google";
    const targetCampaignId = ctx.dest[esp];
    if (!targetCampaignId) { skippedNoDest++; continue; }
    usedEsps.add(esp);
    candidates.push({
      source: "campaign", rowId: l.id, email: l.email, esp,
      first_name: l.first_name ?? null, last_name: l.last_name ?? null, company: l.company ?? null,
      obLeadId: l.id, sourceInstance: ctx.sourceInstance,
      custom_variables: Array.isArray(l.custom_variables) ? l.custom_variables.filter((v) => v && v.name && v.value != null) : [],
      lane: ctx.targetLane, instance: ctx.targetInstance,
    });
  }

  const map: CampaignMapEntry[] = [];
  for (const esp of ESPS) {
    const cid = ctx.dest[esp];
    if (cid && usedEsps.has(esp)) map.push({ bison_instance: ctx.targetInstance, esp, campaign_id: cid, campaign_name: null, lane: ctx.targetLane });
  }
  const none = { moved: 0, movedByKey: {}, skippedArea, skippedLane, skippedNoDest, noEmail, suppressed: 0, espGuessed, failed: [] };
  if (!candidates.length || !map.length) return none;

  let moved = 0;
  const movedByKey: Record<string, number> = {};
  const nowIso = new Date().toISOString();
  const rc = await routeCandidates(ctx.clientTag, candidates, map, {
    onAttached: async (campaignId, resolved) => {
      moved += resolved.length;
      const key = `${ctx.targetLane}:${resolved[0]?.esp || "google"}`;
      movedByKey[key] = (movedByKey[key] || 0) + resolved.length;
      await logMoved(ctx.clientTag, ctx.sourceInstance, ctx.sourceCampaignId, ctx.targetInstance, campaignId, resolved, nowIso);
    },
  });
  return { moved, movedByKey, skippedArea, skippedLane, skippedNoDest, noEmail, suppressed: rc.suppressedExcluded ?? 0, espGuessed, failed: toFailed(rc, candidates.length) };
}

// ── Same-instance (lane-aware) window ────────────────────────────────────────

export interface MoveSameParams {
  runId: string | null;
  clientTag: string;
  sourceInstance: string;
  sourceCampaignId: number;
  sourceCampaignName: string;
  b2bInstance: string;
  b2cInstance: string;
  dest: SameDest;
  serviceAreaFilter: boolean;
  cursor: string | null;
  windowMs?: number;
  windowLeads?: number;
  subWindow?: number;
}
/** As MoveCrossResult; `skipped` = no destination for the lead's (lane, ESP). */
export interface MoveSameResult {
  fetched: number; processed: number; movedByKey: Record<string, number>; skipped: number; skippedArea: number;
  noEmail: number; suppressed: number; espGuessed: number; failed: FailedLead[];
  nextCursor: string | null; done: boolean; error?: string;
}

interface SameCtx {
  clientTag: string; sourceInstance: string; sourceCampaignId: number; sourceCampaignName: string;
  b2bInstance: string; b2cInstance: string; dest: SameDest; campaignEsp: Esp | null; needsLookup: boolean;
  area: Awaited<ReturnType<typeof getServiceArea>>; runId: string | null;
}

export async function moveSameWindow(p: MoveSameParams): Promise<MoveSameResult> {
  const campaignEsp = detectCampaignEsp(p.sourceCampaignName);
  const needsLookup = true;
  const area = p.serviceAreaFilter ? await getServiceArea(p.clientTag) : null;
  const ctx: SameCtx = {
    clientTag: p.clientTag, sourceInstance: p.sourceInstance, sourceCampaignId: p.sourceCampaignId, sourceCampaignName: p.sourceCampaignName,
    b2bInstance: p.b2bInstance, b2cInstance: p.b2cInstance, dest: p.dest, campaignEsp, needsLookup, area, runId: p.runId,
  };

  const WINDOW = p.windowLeads ?? (needsLookup ? 800 : 2500);
  const SUB_WINDOW = p.subWindow ?? (needsLookup ? 400 : 800);
  const WINDOW_MS = p.windowMs ?? DEFAULT_SAME_WINDOW_MS;

  const movedByKey: Record<string, number> = {};
  const t = { processed: 0, skipped: 0, skippedArea: 0, noEmail: 0, suppressed: 0, espGuessed: 0 };
  const failed: FailedLead[] = [];
  let fetched = 0;
  let cursor: string | null = p.cursor;
  let done = false;
  const w: { error: Error | null; at: string | null } = { error: null, at: null };
  let writeChain: Promise<void> = Promise.resolve();
  const deadline = Date.now() + WINDOW_MS;
  const out = (nextCursor: string | null, isDone: boolean, error?: string): MoveSameResult =>
    ({ fetched, ...t, movedByKey, failed, nextCursor, done: isDone, ...(error ? { error } : {}) });

  for (;;) {
    if (deadline - Date.now() <= 0) break;
    const chunkStart = cursor;
    let s: { leads: OutboundLead[]; nextCursor: string | null; done: boolean };
    try {
      s = await sweepCampaignLeadsCursor(p.sourceInstance, p.sourceCampaignId, cursor, { maxLeads: SUB_WINDOW, maxMs: Math.min(deadline - Date.now(), 60_000) });
    } catch (e) {
      await writeChain;
      if (w.error) return out(w.at, false, `move failed: ${w.error.message}`);
      if (fetched === 0) return out(cursor, false, `fetch failed: ${(e as Error).message}`);
      return out(cursor, false);
    }
    fetched += s.leads.length;
    cursor = s.nextCursor;
    done = s.done;

    const chunk = s.leads;
    const prev = writeChain;
    writeChain = (async () => {
      await prev;
      if (w.error) return;
      try {
        const r = await routeAndLogLane(chunk, ctx);
        for (const [k, n] of Object.entries(r.movedByKey)) movedByKey[k] = (movedByKey[k] || 0) + n;
        t.skipped += r.skipped; t.skippedArea += r.skippedArea; t.noEmail += r.noEmail; t.suppressed += r.suppressed; t.espGuessed += r.espGuessed;
        failed.push(...r.failed);
        t.processed += chunk.length;
      } catch (e) { w.error = e as Error; w.at = chunkStart; }
    })();

    if (done || !cursor || fetched >= WINDOW) break;
  }

  await writeChain;
  if (w.error) return out(w.at, false, `move failed: ${w.error.message}`);
  return out(done ? null : cursor, done);
}

async function routeAndLogLane(leads: OutboundLead[], ctx: SameCtx): Promise<{ movedByKey: Record<string, number>; skipped: number; skippedArea: number; noEmail: number; suppressed: number; espGuessed: number; failed: FailedLead[] }> {
  let gated = leads;
  let skippedArea = 0;
  if (ctx.area) {
    const inArea: OutboundLead[] = [];
    const outArea: OutboundLead[] = [];
    for (const l of leads) {
      const city = cityFromCustomVars(l.custom_variables);
      if (city && !cityInServiceArea(city, ctx.area.tokens)) outArea.push(l);
      else inArea.push(l);
    }
    if (outArea.length) { await persistSkipped(outArea, { ...ctx, targetInstance: ctx.sourceInstance }); skippedArea += outArea.length; }
    gated = inArea;
  }
  const withEmail = gated.filter((l) => (l.email || "").trim());
  const noEmail = gated.length - withEmail.length;

  const { espByEmail, guessed: espGuessed } = await resolveEsps(ctx.sourceInstance, withEmail, ctx.needsLookup ? null : ctx.campaignEsp);

  const candidates: Candidate[] = [];
  let skipped = 0;
  const usedKeys = new Set<string>();
  for (const l of withEmail) {
    const esp = espByEmail.get(l.email) || "google";
    const lane: Lane = isPersonalDomain(l.email) ? "b2c" : "b2b";
    const targetCampaignId = ctx.dest[lane][esp];
    if (!targetCampaignId) { skipped++; continue; }
    usedKeys.add(`${lane}:${esp}`);
    candidates.push({
      source: "campaign", rowId: l.id, email: l.email, esp,
      first_name: l.first_name ?? null, last_name: l.last_name ?? null, company: l.company ?? null,
      obLeadId: l.id, sourceInstance: ctx.sourceInstance,
      custom_variables: Array.isArray(l.custom_variables) ? l.custom_variables.filter((v) => v && v.name && v.value != null) : [],
      lane, instance: lane === "b2c" ? ctx.b2cInstance : ctx.b2bInstance,
    });
  }

  const map: CampaignMapEntry[] = [];
  for (const lane of LANES) {
    const inst = lane === "b2c" ? ctx.b2cInstance : ctx.b2bInstance;
    for (const esp of ESPS) {
      const cid = ctx.dest[lane][esp];
      if (cid && usedKeys.has(`${lane}:${esp}`)) map.push({ bison_instance: inst, esp, campaign_id: cid, campaign_name: null, lane });
    }
  }
  if (!candidates.length || !map.length) return { movedByKey: {}, skipped, skippedArea, noEmail, suppressed: 0, espGuessed, failed: [] };

  const movedByKey: Record<string, number> = {};
  const nowIso = new Date().toISOString();
  const rc = await routeCandidates(ctx.clientTag, candidates, map, {
    onAttached: async (campaignId, resolved) => {
      const lane = resolved[0]?.lane || "b2b";
      const esp = resolved[0]?.esp || "google";
      const targetInstance = String(resolved[0]?.instance || "");
      movedByKey[`${lane}:${esp}`] = (movedByKey[`${lane}:${esp}`] || 0) + resolved.length;
      await logMoved(ctx.clientTag, ctx.sourceInstance, ctx.sourceCampaignId, targetInstance, campaignId, resolved, nowIso);
    },
  });
  return { movedByKey, skipped, skippedArea, noEmail, suppressed: rc.suppressedExcluded ?? 0, espGuessed, failed: toFailed(rc, candidates.length) };
}

// ── Sending failed leads again ───────────────────────────────────────────────

export interface RetryLead { key: string; clientTag: string; sourceInstance: string; sourceCampaignId: number; campaignId: number; candidate: Candidate }
export interface RetryOutcome {
  /** key → lane:esp of the campaign it reached. */
  moved: Map<string, string>;
  /** key → why it failed again. */
  failed: Map<string, string>;
  /** Neither — left out because the client removed it for a service-area change since. */
  left: Set<string>;
}

/**
 * Sends leads that failed earlier to the campaign they were bound for — the same route as the window (create
 * in the target instance if needed, then attach), one routeCandidates call per client and source campaign.
 * A whole group failing doesn't throw here: each lead just stays failed, with the new reason.
 */
export async function retryFailedLeads(rows: RetryLead[]): Promise<RetryOutcome> {
  const res: RetryOutcome = { moved: new Map(), failed: new Map(), left: new Set() };
  const groups = new Map<string, RetryLead[]>();
  for (const r of rows) {
    const g = `${r.clientTag}|${r.sourceInstance}|${r.sourceCampaignId}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(r);
  }
  for (const list of groups.values()) {
    const { clientTag, sourceInstance, sourceCampaignId } = list[0];
    const byEmail = new Map(list.map((r) => [r.candidate.email.toLowerCase(), r]));
    const map: CampaignMapEntry[] = [];
    const seen = new Set<string>();
    for (const r of list) {
      const c = r.candidate;
      const k = `${c.instance}|${c.esp}`;
      if (!c.instance || !r.campaignId || seen.has(k)) continue;
      seen.add(k);
      map.push({ bison_instance: c.instance, esp: c.esp, campaign_id: r.campaignId, campaign_name: null, lane: c.lane ?? "b2b" });
    }
    const nowIso = new Date().toISOString();
    try {
      const rc = await routeCandidates(clientTag, list.map((r) => r.candidate), map, {
        onAttached: async (campaignId, resolved) => {
          for (const c of resolved) { const r = byEmail.get(c.email.toLowerCase()); if (r) res.moved.set(r.key, `${c.lane ?? "b2b"}:${c.esp}`); }
          await logMoved(clientTag, sourceInstance, sourceCampaignId, String(resolved[0]?.instance || ""), campaignId, resolved, nowIso);
        },
      });
      for (const f of rc.failed) { const r = byEmail.get(f.candidate.email.toLowerCase()); if (r) res.failed.set(r.key, f.reason); }
    } catch (e) {
      for (const r of list) if (!res.moved.has(r.key)) res.failed.set(r.key, `sending it again failed: ${(e as Error).message}`);
    }
    for (const r of list) if (!res.moved.has(r.key) && !res.failed.has(r.key)) res.left.add(r.key);
  }
  return res;
}
