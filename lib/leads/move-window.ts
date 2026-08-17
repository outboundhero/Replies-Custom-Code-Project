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
 * fetched, or a create/attach failure); a mid-window read error with partial
 * progress returns the current cursor with no error so the caller resumes.
 */
import db from "@/lib/db";
import { sweepCampaignLeadsCursor, findLeadByEmail, type OutboundLead } from "@/lib/outboundhero-api";
import { routeCandidates, type Candidate } from "@/lib/nurture/route-candidates";
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
export interface MoveCrossResult {
  fetched: number; moved: number; skippedArea: number; skippedLane: number; skippedNoDest: number;
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

  let moved = 0, skippedArea = 0, skippedLane = 0, skippedNoDest = 0, fetched = 0;
  let cursor: string | null = p.cursor;
  let done = false;
  const w: { error: Error | null } = { error: null };
  let writeChain: Promise<void> = Promise.resolve();
  const deadline = Date.now() + WINDOW_MS;

  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    let s: { leads: OutboundLead[]; nextCursor: string | null; done: boolean };
    try {
      s = await sweepCampaignLeadsCursor(p.sourceInstance, p.sourceCampaignId, cursor, { maxLeads: SUB_WINDOW, maxMs: Math.min(remainingMs, 60_000) });
    } catch (e) {
      await writeChain;
      if (w.error) return { fetched, moved, skippedArea, skippedLane, skippedNoDest, nextCursor: cursor, done: false, error: `move failed: ${w.error.message}` };
      if (fetched === 0) return { fetched, moved, skippedArea, skippedLane, skippedNoDest, nextCursor: cursor, done: false, error: `fetch failed: ${(e as Error).message}` };
      return { fetched, moved, skippedArea, skippedLane, skippedNoDest, nextCursor: cursor, done: false }; // partial → resume
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
        moved += r.moved; skippedArea += r.skippedArea; skippedLane += r.skippedLane; skippedNoDest += r.skippedNoDest;
      } catch (e) { w.error = e as Error; }
    })();

    if (done || !cursor || fetched >= WINDOW) break;
  }

  await writeChain;
  if (w.error) return { fetched, moved, skippedArea, skippedLane, skippedNoDest, nextCursor: cursor, done: false, error: `move failed: ${w.error.message}` };
  return { fetched, moved, skippedArea, skippedLane, skippedNoDest, nextCursor: done ? null : cursor, done };
}

async function routeAndLog(leads: OutboundLead[], ctx: CrossCtx): Promise<{ moved: number; skippedArea: number; skippedLane: number; skippedNoDest: number }> {
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

  const espByEmail = new Map<string, Esp>();
  if (!ctx.needsLookup && ctx.campaignEsp) {
    for (const l of withEmail) espByEmail.set(l.email, ctx.campaignEsp);
  } else {
    await parallelForEach(withEmail, 8, async (l) => {
      let esp: Esp;
      try {
        const full = await findLeadByEmail(ctx.sourceInstance, l.email);
        const tag = pickEspFromTags(full?.tags);
        esp = tag ? bucketEsp(tag) : detectEsp(l.email);
      } catch { esp = detectEsp(l.email); }
      espByEmail.set(l.email, esp);
    });
  }

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
  if (!candidates.length || !map.length) return { moved: 0, skippedArea, skippedLane, skippedNoDest };

  let moved = 0;
  const nowIso = new Date().toISOString();
  await routeCandidates(ctx.clientTag, candidates, map, {
    onAttached: async (campaignId, resolved) => {
      moved += resolved.length;
      await logMoved(ctx.clientTag, ctx.sourceInstance, ctx.sourceCampaignId, ctx.targetInstance, campaignId, resolved, nowIso);
    },
  });
  return { moved, skippedArea, skippedLane, skippedNoDest };
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
export interface MoveSameResult {
  fetched: number; movedByKey: Record<string, number>; skipped: number; skippedArea: number;
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
  let skipped = 0, skippedArea = 0, fetched = 0;
  let cursor: string | null = p.cursor;
  let done = false;
  const w: { error: Error | null } = { error: null };
  let writeChain: Promise<void> = Promise.resolve();
  const deadline = Date.now() + WINDOW_MS;

  for (;;) {
    if (deadline - Date.now() <= 0) break;
    let s: { leads: OutboundLead[]; nextCursor: string | null; done: boolean };
    try {
      s = await sweepCampaignLeadsCursor(p.sourceInstance, p.sourceCampaignId, cursor, { maxLeads: SUB_WINDOW, maxMs: Math.min(deadline - Date.now(), 60_000) });
    } catch (e) {
      await writeChain;
      if (w.error) return { fetched, movedByKey, skipped, skippedArea, nextCursor: cursor, done: false, error: `move failed: ${w.error.message}` };
      if (fetched === 0) return { fetched, movedByKey, skipped, skippedArea, nextCursor: cursor, done: false, error: `fetch failed: ${(e as Error).message}` };
      return { fetched, movedByKey, skipped, skippedArea, nextCursor: cursor, done: false };
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
        skipped += r.skipped; skippedArea += r.skippedArea;
      } catch (e) { w.error = e as Error; }
    })();

    if (done || !cursor || fetched >= WINDOW) break;
  }

  await writeChain;
  if (w.error) return { fetched, movedByKey, skipped, skippedArea, nextCursor: cursor, done: false, error: `move failed: ${w.error.message}` };
  return { fetched, movedByKey, skipped, skippedArea, nextCursor: done ? null : cursor, done };
}

async function routeAndLogLane(leads: OutboundLead[], ctx: SameCtx): Promise<{ movedByKey: Record<string, number>; skipped: number; skippedArea: number }> {
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

  const espByEmail = new Map<string, Esp>();
  if (!ctx.needsLookup && ctx.campaignEsp) {
    for (const l of withEmail) espByEmail.set(l.email, ctx.campaignEsp);
  } else {
    await parallelForEach(withEmail, 8, async (l) => {
      let esp: Esp;
      try {
        const full = await findLeadByEmail(ctx.sourceInstance, l.email);
        const tag = pickEspFromTags(full?.tags);
        esp = tag ? bucketEsp(tag) : detectEsp(l.email);
      } catch { esp = detectEsp(l.email); }
      espByEmail.set(l.email, esp);
    });
  }

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
  if (!candidates.length || !map.length) return { movedByKey: {}, skipped, skippedArea };

  const movedByKey: Record<string, number> = {};
  const nowIso = new Date().toISOString();
  await routeCandidates(ctx.clientTag, candidates, map, {
    onAttached: async (campaignId, resolved) => {
      const lane = resolved[0]?.lane || "b2b";
      const esp = resolved[0]?.esp || "google";
      const targetInstance = String(resolved[0]?.instance || "");
      movedByKey[`${lane}:${esp}`] = (movedByKey[`${lane}:${esp}`] || 0) + resolved.length;
      await logMoved(ctx.clientTag, ctx.sourceInstance, ctx.sourceCampaignId, targetInstance, campaignId, resolved, nowIso);
    },
  });
  return { movedByKey, skipped, skippedArea };
}
