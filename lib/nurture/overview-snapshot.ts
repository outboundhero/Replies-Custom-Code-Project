/**
 * Precomputed Nurture overview — so the Nurture pages load in one small read.
 *
 * buildOverview() merges ~14 sources (incl. a Google Sheet read that's ~2s
 * cold), so pages never call it directly. Instead the whole result is stored
 * as ONE Turso row and served from there (~50ms):
 *   • rebuilt by the crons that change its inputs (campaign snapshot, queue
 *     stats / last contact, churn sync, auto-map) and right after every Nurture
 *     action (queue remove / undo, refresh numbers, auto-nurture toggle, map
 *     save, churn sync);
 *   • stale-while-revalidate: a read older than FRESH_MS (crons normally
 *     rebuild every ~10 min, so this only kicks in if they stall) is still served
 *     instantly and a rebuild is kicked off in the background (after()).
 *   • each server keeps the last parsed snapshot in memory: a read is still one
 *     round trip, but the ~600KB payload only travels when it actually changed.
 */
import { after } from "next/server";
import db from "@/lib/db";
import { buildOverview, type OverviewTag } from "@/lib/nurture/overview";

export type Overview = Awaited<ReturnType<typeof buildOverview>>;
const FRESH_MS = 15 * 60_000;

let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = db.execute("CREATE TABLE IF NOT EXISTS nurture_overview_snapshot (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, built_at TEXT NOT NULL)")
      .then(() => undefined).catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

// The newest snapshot this server has seen (parsed), so unchanged reads skip the payload.
let memo: { data: Overview; builtAt: string } | null = null;
const remember = (o: { data: Overview; builtAt: string }) => {
  if (!memo || o.builtAt > memo.builtAt) memo = o;
  return o;
};

async function buildAndStore(): Promise<{ data: Overview; builtAt: string }> {
  await ensureTable();
  // builtAt = when the build STARTED (= "data as of"). Stored only if newer than
  // what's there, so a slow build on another server can't overwrite a fresher one.
  const builtAt = new Date().toISOString();
  const data = await buildOverview();
  await db.execute({
    sql: `INSERT INTO nurture_overview_snapshot (id, payload, built_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, built_at = excluded.built_at
          WHERE excluded.built_at > nurture_overview_snapshot.built_at`,
    args: [JSON.stringify(data), builtAt],
  });
  return remember({ data, builtAt });
}

// One background rebuild at a time per server (concurrent callers share it).
// `force` (after the caller's own change) always starts a NEW build, so it can
// never be handed a build that began before that change.
let inflight: Promise<{ data: Overview; builtAt: string }> | null = null;
export function rebuildOverviewSnapshot(opts: { force?: boolean } = {}): Promise<{ data: Overview; builtAt: string }> {
  if (opts.force) return buildAndStore();
  if (!inflight) inflight = buildAndStore().finally(() => { inflight = null; });
  return inflight;
}

/** When the stored snapshot was built (one tiny read), or null. */
export async function snapshotBuiltAt(): Promise<string | null> {
  await ensureTable();
  const r = await db.execute("SELECT built_at FROM nurture_overview_snapshot WHERE id = 1");
  return r.rows[0] ? String(r.rows[0].built_at) : null;
}

/**
 * Rebuild after the response is sent (never throws into the caller).
 * `ifOlderThanMs`: skip if another server already rebuilt it that recently
 * (stale-while-revalidate reads on several servers at once → one rebuild).
 */
export function scheduleOverviewRebuild(opts: { ifOlderThanMs?: number } = {}): void {
  const run = async () => {
    try {
      if (opts.ifOlderThanMs) {
        const at = await snapshotBuiltAt();
        if (at && Date.now() - new Date(at).getTime() < opts.ifOlderThanMs) return;
      }
      await rebuildOverviewSnapshot();
    } catch (e) { console.error("[overview-snapshot] rebuild failed:", (e as Error).message); }
  };
  try { after(run); }
  catch { void run(); } // outside a request scope (scripts) — best-effort inline
}

/**
 * The overview, instantly. `fresh` forces a rebuild first (after the page's
 * own actions); otherwise a stale snapshot is served and refreshed behind.
 */
export async function getOverview(opts: { fresh?: boolean } = {}): Promise<{ data: Overview; builtAt: string }> {
  if (opts.fresh) return rebuildOverviewSnapshot({ force: true });
  await ensureTable();
  // The payload comes back only if the stored snapshot differs from ours.
  const known = memo;
  const r = await db.execute({
    sql: "SELECT built_at, CASE WHEN built_at = ? THEN NULL ELSE payload END AS payload FROM nurture_overview_snapshot WHERE id = 1",
    args: [known?.builtAt ?? ""],
  });
  const row = r.rows[0];
  if (!row) return rebuildOverviewSnapshot();
  const builtAt = String(row.built_at);
  if (Date.now() - new Date(builtAt).getTime() > FRESH_MS) scheduleOverviewRebuild({ ifOlderThanMs: FRESH_MS });
  if (row.payload == null && known) return known; // unchanged since we last read it
  return remember({ data: JSON.parse(String(row.payload)) as Overview, builtAt });
}

// ── response shapes shared by the API routes and the server-rendered pages ──

/** Overview table row: exactly the fields the overview page renders / filters on. */
function lean(t: OverviewTag) {
  const s = t.stats;
  return {
    tag: t.tag, type: t.type, prelaunch: t.prelaunch,
    mainActive: t.mainActive, nurtureActive: t.nurtureActive, sendingLeads: t.sendingLeads,
    mapping: t.mapping, mapIssues: t.mapIssues, batches: t.batches, extraLiveBatches: t.extraLiveBatches,
    lastContactDay: t.lastContactDay, lastContactCheckedAt: t.lastContactCheckedAt,
    added: t.added, stoppedRecovered: t.stoppedRecovered, errors: t.errors,
    stats: s ? {
      queue: s.queue, ready: s.ready, sources: s.sources, esps: s.esps,
      email_endings: s.email_endings, site_endings: s.site_endings, email_domains: s.email_domains,
      computed_at: s.computed_at,
    } : null,
  };
}

export function overviewPayload(o: { data: Overview; builtAt: string }) {
  const tags = o.data.tags;
  return {
    automation: o.data.automation,
    tiles: {
      activeClients: tags.length,
      inNurture: tags.filter((t) => t.nurtureActive > 0).length,
      contactsInQueues: tags.reduce((s, t) => s + (t.stats?.queue ?? 0), 0),
      statsCoverage: tags.filter((t) => t.stats).length,
      mappingOk: tags.filter((t) => t.mapping === "ok").length,
      mappingBad: tags.filter((t) => t.mapping === "bad").length,
      tagsWithErrors: tags.filter((t) => t.errors.length > 0).length,
    },
    tags: tags.map(lean),
    campaignsSyncedAt: o.data.campaignsSyncedAt,
    builtAt: o.builtAt,
  };
}
export type OverviewPayload = ReturnType<typeof overviewPayload>;

export function clientPayload(o: { data: Overview; builtAt: string }, tag: string) {
  const t = o.data.tags.find((x) => x.tag.toUpperCase() === tag.trim().toUpperCase());
  if (!t) return null;
  const { slots, batchCampaigns, ...client } = t;
  return {
    client,
    slots,
    batches: batchCampaigns.map((b, i) => ({ batch: b.batch, state: t.batches[i], campaigns: b.campaigns })),
    builtAt: o.builtAt,
  };
}
export type ClientPayload = NonNullable<ReturnType<typeof clientPayload>>;

/** The queue tab's first page as last cached by the stats refresh (painted instantly, refreshed live). */
export async function getCachedFirstQueuePage(tag: string): Promise<{ total: number; contacts: unknown[]; computedAt: string } | null> {
  try {
    const r = await db.execute({ sql: "SELECT payload, computed_at FROM nurture_queue_page1_cache WHERE client_tag = ?", args: [tag.trim().toUpperCase()] });
    const row = r.rows[0];
    if (!row) return null;
    const p = JSON.parse(String(row.payload)) as { total: number; contacts: unknown[] };
    return { total: Number(p.total) || 0, contacts: p.contacts || [], computedAt: String(row.computed_at) };
  } catch { return null; }
}
