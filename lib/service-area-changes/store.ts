/**
 * Service-area removals — durable state (Turso). One `sa_change` per "remove
 * these places" request; its scan work (`sa_task`), the leads it found
 * (`sa_lead`, one row per email, with the Remove tick) and where each one sits
 * (`sa_member`: a campaign in an instance, or the nurture queue).
 *
 * Status flow:
 *   planning → scanning → review → approved → topup → removing → verifying → done | partial
 *   (cancelled from planning / scanning / review / approved)
 * `planning` = tasks being written (a change only scans once ALL its tasks exist).
 * `topup` = on the removal day, a quick search for leads that arrived in the
 * removed places since the check; then the removal. Removal starts at
 * `removal_at` (00:00 Pacific on the 6th day counting the notice day as day 1)
 * and only for an approved change.
 */
import db from "@/lib/db";
import {
  classify, mergeSignals, normCity, signalsOf, type CityStates, type LeadClass, type LocationInput, type Place, type Signals, type ZipFacts,
} from "@/lib/service-area-changes/places";

export type ChangeStatus = "planning" | "scanning" | "review" | "approved" | "topup" | "removing" | "verifying" | "done" | "partial" | "cancelled";
export type TaskKind = "search" | "full" | "queue" | "enrich";
export type MemberKind = "main" | "nurture" | "queue";
/**
 * removed = taken out, waiting for the check · verified = confirmed gone · failed ·
 * kept = not removed: on the day its details no longer put it in a removed place ·
 * let_in = someone let it back in.
 */
export type LeadResult = "removed" | "verified" | "failed" | "kept" | "let_in";

/** Statuses in which the scan may still write leads. */
export const SCANNING: ChangeStatus[] = ["scanning", "topup"];
/** Statuses in which ticks can change. */
export const EDITABLE: ChangeStatus[] = ["scanning", "review"];

const nowIso = () => new Date().toISOString();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const num = (v: unknown) => Number(v) || 0;

let ready: Promise<void> | null = null;
export function ensureTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await db.execute(`CREATE TABLE IF NOT EXISTS sa_change (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_tag TEXT NOT NULL,
        places_json TEXT NOT NULL,
        notice_date TEXT NOT NULL,
        removal_date TEXT NOT NULL,
        removal_at TEXT NOT NULL,
        note TEXT,
        status TEXT NOT NULL,
        created_by TEXT, created_at TEXT NOT NULL,
        approved_by TEXT, approved_at TEXT,
        cancelled_by TEXT, cancelled_at TEXT,
        campaigns_json TEXT,
        quick_done_at TEXT, scan_done_at TEXT,
        topup_started_at TEXT,
        removal_started_at TEXT, removal_finished_at TEXT,
        suppressed_at TEXT, queue_done_at TEXT, queue_rows INTEGER, queue_removal_id INTEGER, queue_cursor TEXT,
        verify_after TEXT, verify_round INTEGER NOT NULL DEFAULT 0, verified_at TEXT,
        recheck_at TEXT, rechecked_at TEXT, came_back INTEGER NOT NULL DEFAULT 0,
        lease_holder TEXT, heartbeat_at TEXT,
        error TEXT,
        updated_at TEXT NOT NULL
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS sa_task (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        change_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        instance TEXT, campaign_id INTEGER, campaign_name TEXT, campaign_kind TEXT,
        term TEXT, src TEXT,
        cursor TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        scanned INTEGER NOT NULL DEFAULT 0,
        hits INTEGER NOT NULL DEFAULT 0,
        total INTEGER,
        error TEXT,
        updated_at TEXT
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS sa_lead (
        change_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        raw_emails TEXT,
        name TEXT, company TEXT,
        city TEXT, state TEXT, zip TEXT, address TEXT,
        signals_json TEXT NOT NULL,
        cls TEXT NOT NULL,
        place_key TEXT, reason TEXT,
        remove INTEGER NOT NULL DEFAULT 0,
        decided_by TEXT, decided_at TEXT,
        replied INTEGER NOT NULL DEFAULT 0,
        result TEXT, result_detail TEXT, found_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        xchecked INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT,
        PRIMARY KEY (change_id, email)
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS sa_member (
        change_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        instance TEXT NOT NULL,
        campaign_id INTEGER NOT NULL,
        campaign_name TEXT,
        kind TEXT NOT NULL,
        lead_id INTEGER NOT NULL,
        lead_status TEXT,
        PRIMARY KEY (change_id, email, instance, campaign_id, lead_id)
      )`);
      // Columns added after the first version of the tables.
      // found_on_day = 1: first found by the removal-day top-up (never in the reviewed list).
      try { await db.execute("ALTER TABLE sa_lead ADD COLUMN found_on_day INTEGER NOT NULL DEFAULT 0"); } catch { /* already there */ }
      // last_run_at: when a runner last took the change (turns + back-off in leaseChange).
      try { await db.execute("ALTER TABLE sa_change ADD COLUMN last_run_at TEXT"); } catch { /* already there */ }
      // At most one open change per client, even if two are started at the same moment.
      try {
        await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_sa_change_one_open ON sa_change(client_tag) WHERE status NOT IN ('done', 'partial', 'cancelled')");
      } catch (e) { console.warn("[service-area] one-open-change index not created:", (e as Error).message); }
      await db.execute("CREATE INDEX IF NOT EXISTS idx_sa_change_tag ON sa_change(client_tag, created_at)");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_sa_change_status ON sa_change(status)");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_sa_task_change ON sa_task(change_id, status, kind)");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_sa_lead_cls ON sa_lead(change_id, cls, email)");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_sa_lead_todo ON sa_lead(change_id, remove, result)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── changes ──────────────────────────────────────────────────────────────────

export interface ScanCampaign { instance: string; id: number; name: string; status: string; kind: "main" | "nurture"; leads: number }

export interface Change {
  id: number; clientTag: string; places: Place[];
  noticeDate: string; removalDate: string; removalAt: string; note: string | null;
  status: ChangeStatus; createdBy: string | null; createdAt: string;
  approvedBy: string | null; approvedAt: string | null; cancelledBy: string | null; cancelledAt: string | null;
  campaigns: ScanCampaign[];
  quickDoneAt: string | null; scanDoneAt: string | null; topupStartedAt: string | null;
  removalStartedAt: string | null; removalFinishedAt: string | null;
  suppressedAt: string | null; queueDoneAt: string | null; queueRows: number | null; queueRemovalId: number | null; queueCursor: string | null;
  verifyAfter: string | null; verifyRound: number; verifiedAt: string | null;
  recheckAt: string | null; recheckedAt: string | null; cameBack: number;
  leaseHolder: string | null; heartbeatAt: string | null; error: string | null; updatedAt: string;
}

function toChange(r: Row): Change {
  return {
    id: num(r.id), clientTag: String(r.client_tag), places: JSON.parse(String(r.places_json || "[]")),
    noticeDate: String(r.notice_date), removalDate: String(r.removal_date), removalAt: String(r.removal_at), note: r.note ?? null,
    status: String(r.status) as ChangeStatus, createdBy: r.created_by ?? null, createdAt: String(r.created_at),
    approvedBy: r.approved_by ?? null, approvedAt: r.approved_at ?? null, cancelledBy: r.cancelled_by ?? null, cancelledAt: r.cancelled_at ?? null,
    campaigns: r.campaigns_json ? JSON.parse(String(r.campaigns_json)) : [],
    quickDoneAt: r.quick_done_at ?? null, scanDoneAt: r.scan_done_at ?? null, topupStartedAt: r.topup_started_at ?? null,
    removalStartedAt: r.removal_started_at ?? null, removalFinishedAt: r.removal_finished_at ?? null,
    suppressedAt: r.suppressed_at ?? null, queueDoneAt: r.queue_done_at ?? null, queueRows: r.queue_rows == null ? null : num(r.queue_rows),
    queueRemovalId: r.queue_removal_id == null ? null : num(r.queue_removal_id), queueCursor: r.queue_cursor ?? null,
    verifyAfter: r.verify_after ?? null, verifyRound: num(r.verify_round), verifiedAt: r.verified_at ?? null,
    recheckAt: r.recheck_at ?? null, recheckedAt: r.rechecked_at ?? null, cameBack: num(r.came_back),
    leaseHolder: r.lease_holder ?? null, heartbeatAt: r.heartbeat_at ?? null, error: r.error ?? null, updatedAt: String(r.updated_at),
  };
}

/** What the screens get for a change. */
export function changeSummary(c: Change) {
  return {
    id: c.id, clientTag: c.clientTag, places: c.places, noticeDate: c.noticeDate, removalDate: c.removalDate, removalAt: c.removalAt, note: c.note,
    status: c.status, createdBy: c.createdBy, createdAt: c.createdAt, approvedBy: c.approvedBy, approvedAt: c.approvedAt,
    cancelledBy: c.cancelledBy, cancelledAt: c.cancelledAt, quickDoneAt: c.quickDoneAt, scanDoneAt: c.scanDoneAt,
    removalStartedAt: c.removalStartedAt, removalFinishedAt: c.removalFinishedAt, queueRows: c.queueRows,
    verifiedAt: c.verifiedAt, verifyAfter: c.verifyAfter, recheckAt: c.recheckAt, recheckedAt: c.recheckedAt, cameBack: c.cameBack, error: c.error,
    campaigns: c.campaigns.length, updatedAt: c.updatedAt,
  };
}

export async function getChange(id: number): Promise<Change | null> {
  await ensureTables();
  const r = await db.execute({ sql: "SELECT * FROM sa_change WHERE id = ?", args: [id] });
  return r.rows.length ? toChange(r.rows[0] as Row) : null;
}

export async function listChanges(clientTag: string, limit = 50): Promise<Change[]> {
  await ensureTables();
  const r = await db.execute({ sql: "SELECT * FROM sa_change WHERE client_tag = ? ORDER BY id DESC LIMIT ?", args: [clientTag.toUpperCase(), limit] });
  return r.rows.map((x) => toChange(x as Row));
}

/** A client's changes that haven't finished or been cancelled. */
export async function openChanges(clientTag: string): Promise<Change[]> {
  await ensureTables();
  const r = await db.execute({ sql: "SELECT * FROM sa_change WHERE client_tag = ? AND status NOT IN ('done', 'partial', 'cancelled') ORDER BY id", args: [clientTag.toUpperCase()] });
  return r.rows.map((x) => toChange(x as Row));
}

/** Records a new change in `planning` — it starts scanning once all its tasks are written. */
export async function createChange(input: {
  clientTag: string; places: Place[]; noticeDate: string; removalDate: string; removalAt: string; note: string | null; by: string | null;
}): Promise<number> {
  await ensureTables();
  const now = nowIso();
  const r = await db.execute({
    sql: `INSERT INTO sa_change (client_tag, places_json, notice_date, removal_date, removal_at, note, status, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'planning', ?, ?, ?) RETURNING id`,
    args: [input.clientTag.toUpperCase(), JSON.stringify(input.places), input.noticeDate, input.removalDate, input.removalAt, input.note, input.by, now, now],
  });
  return num(r.rows[0]?.id);
}

/** Update fields on a change, optionally only from the given statuses. Returns true when a row changed. */
export async function patchChange(id: number, fields: Record<string, unknown>, onlyFrom?: ChangeStatus[]): Promise<boolean> {
  const keys = Object.keys(fields);
  const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
  const where = onlyFrom?.length ? ` AND status IN (${onlyFrom.map(() => "?").join(",")})` : "";
  const r = await db.execute({
    sql: `UPDATE sa_change SET ${sets} WHERE id = ?${where}`,
    args: [...keys.map((k) => fields[k] as string | number | null), nowIso(), id, ...(onlyFrom ?? [])],
  });
  return (r.rowsAffected ?? 0) > 0;
}

// ── leasing (one runner per change, one change at a time) ────────────────────

/**
 * A runner that hasn't checked in for this long has died; its change can be
 * taken over. Longer than a function may live (the cron route's maxDuration is
 * 300s), so a slow step inside a live runner can never overlap a second one.
 */
export const LEASE_STALE_MS = 330_000;
/** A change whose last run failed waits this long before it's picked first again (others get their turn). */
const ERROR_BACKOFF_MS = 10 * 60_000;

export class LeaseLost extends Error {
  constructor(id: number) { super(`Lost the hold on service-area change #${id} — another run took it over`); this.name = "LeaseLost"; }
}

const dueSql = `(status IN ('scanning', 'topup', 'removing')
      OR (status = 'approved' AND removal_at <= ?)
      OR (status = 'verifying' AND verify_after <= ?)
      OR (status IN ('done', 'partial') AND recheck_at IS NOT NULL AND recheck_at <= ?))`;

/**
 * Claim the change that most needs work: removals that are due first, then
 * scans, then the 7-day re-check — among equals, the one that waited longest,
 * and one whose last run failed goes to the back for a while, so a change that
 * keeps failing can't hold up every other client's. Global serial — never two
 * at once, so a scan and a removal don't pile onto Email Bison together. The
 * claim carries a holder token: only that runner can check in, release, or
 * write leads.
 */
export async function leaseChange(changeId?: number): Promise<Change | null> {
  await ensureTables();
  const now = nowIso();
  const stale = new Date(Date.now() - LEASE_STALE_MS).toISOString();
  const backoff = new Date(Date.now() - ERROR_BACKOFF_MS).toISOString();
  const free = "(heartbeat_at IS NULL OR heartbeat_at < ?)";
  const order = `CASE WHEN error IS NOT NULL AND last_run_at > ? THEN 3
                      WHEN status IN ('topup', 'removing', 'verifying', 'approved') THEN 0 WHEN status = 'scanning' THEN 1 ELSE 2 END,
                 COALESCE(last_run_at, ''), id`;
  const pick = changeId
    ? await db.execute({ sql: `SELECT id FROM sa_change WHERE id = ? AND ${dueSql} AND ${free} LIMIT 1`, args: [changeId, now, now, now, stale] })
    : await db.execute({ sql: `SELECT id FROM sa_change WHERE ${dueSql} AND ${free} ORDER BY ${order} LIMIT 1`, args: [now, now, now, stale, backoff] });
  if (!pick.rows.length) return null;
  const id = num(pick.rows[0].id);
  const holder = crypto.randomUUID();
  const claim = await db.execute({
    sql: `UPDATE sa_change SET heartbeat_at = ?, lease_holder = ?, last_run_at = ? WHERE id = ? AND ${free}
            AND NOT EXISTS (SELECT 1 FROM sa_change x WHERE x.id <> ? AND x.heartbeat_at IS NOT NULL AND x.heartbeat_at >= ?)`,
    args: [now, holder, now, id, stale, id, stale],
  });
  if (!(claim.rowsAffected ?? 0)) return null;
  const c = await getChange(id);
  return c && c.leaseHolder === holder ? c : null;
}

/** Is there removal work due on another change (so a long scan should step aside)? */
export async function removalDueElsewhere(exceptId: number): Promise<boolean> {
  const now = nowIso();
  const r = await db.execute({
    sql: `SELECT 1 FROM sa_change WHERE id <> ? AND (status IN ('topup', 'removing') OR (status = 'approved' AND removal_at <= ?) OR (status = 'verifying' AND verify_after <= ?)) LIMIT 1`,
    args: [exceptId, now, now],
  });
  return r.rows.length > 0;
}

/** Check in. Throws LeaseLost if another runner holds the change now. */
export async function heartbeat(id: number, holder: string): Promise<void> {
  const r = await db.execute({ sql: "UPDATE sa_change SET heartbeat_at = ? WHERE id = ? AND lease_holder = ?", args: [nowIso(), id, holder] });
  if (!(r.rowsAffected ?? 0)) throw new LeaseLost(id);
}
export async function releaseLease(id: number, holder: string): Promise<void> {
  await db.execute({ sql: "UPDATE sa_change SET heartbeat_at = NULL, lease_holder = NULL WHERE id = ? AND lease_holder = ?", args: [id, holder] });
}

// ── scan tasks ───────────────────────────────────────────────────────────────

export interface Task {
  id: number; changeId: number; kind: TaskKind;
  instance: string | null; campaignId: number | null; campaignName: string | null; campaignKind: "main" | "nurture" | null;
  term: string | null; src: "reply" | "seq" | "legacy" | null;
  cursor: string | null; status: string; attempts: number; scanned: number; hits: number; total: number | null;
}
function toTask(r: Row): Task {
  return {
    id: num(r.id), changeId: num(r.change_id), kind: String(r.kind) as TaskKind,
    instance: r.instance ?? null, campaignId: r.campaign_id == null ? null : num(r.campaign_id), campaignName: r.campaign_name ?? null,
    campaignKind: (r.campaign_kind ?? null) as Task["campaignKind"], term: r.term ?? null, src: (r.src ?? null) as Task["src"],
    cursor: r.cursor ?? null, status: String(r.status), attempts: num(r.attempts), scanned: num(r.scanned), hits: num(r.hits),
    total: r.total == null ? null : num(r.total),
  };
}

export type NewTask = Omit<Task, "id" | "changeId" | "cursor" | "status" | "attempts" | "scanned" | "hits">;

export async function addTasks(changeId: number, tasks: NewTask[]): Promise<void> {
  const now = nowIso();
  for (let i = 0; i < tasks.length; i += 50) {
    await db.batch(tasks.slice(i, i + 50).map((t) => ({
      sql: `INSERT INTO sa_task (change_id, kind, instance, campaign_id, campaign_name, campaign_kind, term, src, total, status, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      args: [changeId, t.kind, t.instance, t.campaignId, t.campaignName, t.campaignKind, t.term, t.src, t.total, now],
    })), "write");
  }
}

/** Pending tasks, up to `perKind` of each kind (so a long list of one kind can't hide the others). */
export async function pendingTasks(changeId: number, kinds: TaskKind[], perKind = 60): Promise<Task[]> {
  const out: Task[] = [];
  for (const k of kinds) {
    const r = await db.execute({ sql: "SELECT * FROM sa_task WHERE change_id = ? AND status = 'pending' AND kind = ? ORDER BY attempts, id LIMIT ?", args: [changeId, k, perKind] });
    out.push(...r.rows.map((x) => toTask(x as Row)));
  }
  return out;
}

export const MAX_TASK_ATTEMPTS = 6;

/**
 * Save one window's result. A task that keeps erroring ends as `failed` (it
 * blocks approval until retried) — or, with `giveUp: "skipped"`, as skipped
 * (the quick search: the full read still covers what it would have found).
 */
export async function saveTaskWindow(
  taskId: number,
  o: { cursor: string | null; done: boolean; scanned: number; hits: number; error?: string },
  opts: { maxAttempts?: number; giveUp?: "failed" | "skipped" } = {},
): Promise<void> {
  const cur = await db.execute({ sql: "SELECT attempts FROM sa_task WHERE id = ?", args: [taskId] });
  const attempts = num(cur.rows[0]?.attempts) + (o.error ? 1 : 0);
  const status = o.done && !o.error ? "done" : o.error && attempts >= (opts.maxAttempts ?? MAX_TASK_ATTEMPTS) ? (opts.giveUp ?? "failed") : "pending";
  await db.execute({
    sql: "UPDATE sa_task SET cursor = ?, scanned = scanned + ?, hits = hits + ?, attempts = ?, status = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    args: [o.cursor, o.scanned, o.hits, attempts, status, o.error ?? null, nowIso(), taskId],
  });
}

export interface TaskProgress { kind: TaskKind; pending: number; done: number; skipped: number; failed: number; scanned: number; total: number }
export async function taskProgress(changeId: number): Promise<TaskProgress[]> {
  const r = await db.execute({
    sql: `SELECT kind, SUM(status = 'pending') AS pending, SUM(status IN ('done', 'skipped')) AS done, SUM(status = 'skipped') AS skipped,
                 SUM(status = 'failed') AS failed, SUM(scanned) AS scanned, SUM(COALESCE(total, 0)) AS total
          FROM sa_task WHERE change_id = ? AND status <> 'cancelled' GROUP BY kind`,
    args: [changeId],
  });
  return r.rows.map((x) => ({ kind: String(x.kind) as TaskKind, pending: num(x.pending), done: num(x.done), skipped: num(x.skipped), failed: num(x.failed), scanned: num(x.scanned), total: num(x.total) }));
}

export async function failedTasks(changeId: number): Promise<Array<{ kind: string; label: string; error: string }>> {
  const r = await db.execute({ sql: "SELECT kind, instance, campaign_name, src, term, error FROM sa_task WHERE change_id = ? AND status = 'failed' LIMIT 50", args: [changeId] });
  return r.rows.map((x) => ({
    kind: String(x.kind),
    label: x.kind === "queue" ? `Nurture queue (${x.src})` : x.kind === "enrich" ? "Checking the leads against our database" : `${x.campaign_name} (${x.instance})${x.term ? ` — search “${x.term}”` : ""}`,
    error: String(x.error ?? ""),
  }));
}

export async function retryFailedTasks(changeId: number): Promise<number> {
  const r = await db.execute({ sql: "UPDATE sa_task SET status = 'pending', attempts = 0, error = NULL, updated_at = ? WHERE change_id = ? AND status = 'failed'", args: [nowIso(), changeId] });
  return r.rowsAffected ?? 0;
}

// ── sightings → leads ────────────────────────────────────────────────────────

export interface Sighting {
  email: string;
  name: string | null;
  company: string | null;
  input: LocationInput;
  replied?: boolean;
  member?: { instance: string; campaignId: number; campaignName: string; kind: MemberKind; leadId: number; leadStatus: string | null };
}

// ZIP facts for classification (the ZIP's city / state), cached for the process.
const zipCache = new Map<string, { city: string; state: string } | null>();
export async function zipFactsFor(zips: Iterable<string>): Promise<ZipFacts> {
  const want = [...new Set([...zips].filter((z) => /^\d{5}$/.test(z)))];
  const missing = want.filter((z) => !zipCache.has(z));
  for (let i = 0; i < missing.length; i += 300) {
    const chunk = missing.slice(i, i + 300);
    const r = await db.execute({ sql: `SELECT zip, city, state FROM us_zip WHERE zip IN (${chunk.map(() => "?").join(",")})`, args: chunk });
    const found = new Map(r.rows.map((x) => [String(x.zip), { city: String(x.city), state: String(x.state) }]));
    for (const z of chunk) zipCache.set(z, found.get(z) ?? null);
  }
  const out: ZipFacts = new Map();
  for (const z of want) { const f = zipCache.get(z); if (f) out.set(z, f); }
  return out;
}

// City → its states, for removed states only (a lead's city has to agree with the
// state). The whole US ZIP table, read once per process.
let cityStatesAll: Promise<CityStates> | null = null;
export async function cityStatesFor(places: Place[]): Promise<CityStates> {
  if (!places.some((p) => p.type === "state")) return new Map();
  if (!cityStatesAll) {
    cityStatesAll = (async () => {
      const r = await db.execute("SELECT city, state FROM us_zip");
      const m: CityStates = new Map();
      for (const x of r.rows) {
        const c = normCity(String(x.city));
        if (!c) continue;
        if (!m.has(c)) m.set(c, new Set());
        m.get(c)!.add(String(x.state));
      }
      return m;
    })().catch((e) => { cityStatesAll = null; throw e; });
  }
  return cityStatesAll;
}

const normEmail = (e: string) => String(e || "").trim().toLowerCase();

// One fold at a time per change in this process: two windows folding the same
// email at once would each read the old row and the second write would lose the
// first's signals.
const foldLocks = new Map<number, Promise<unknown>>();
function serially<T>(changeId: number, fn: () => Promise<T>): Promise<T> {
  const prev = foldLocks.get(changeId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  foldLocks.set(changeId, next);
  void next.finally(() => { if (foldLocks.get(changeId) === next) foldLocks.delete(changeId); }).catch(() => undefined);
  return next;
}

/**
 * Fold a batch of sightings into the change's leads: every sighting of the same
 * email adds its location signals, and the lead is re-decided on all of them.
 * Leads not in a removed place are only kept if they were already listed (a
 * new signal can change their decision). The Remove tick follows the decision
 * (on for "in removed area") unless someone has set it by hand — a hand-set
 * tick is never overwritten, even one set a moment ago.
 * With `onlyExisting`, signals are merged into listed leads only (no new rows).
 * `holder` (the runner's lease) is checked before writing: a runner that lost
 * its hold, or a change that has left scanning, writes nothing.
 *
 * On the removal day (`topup`) the approved list is frozen: a lead already on
 * it only gains the campaigns it was seen in — its tick, its reading and its
 * row never change (the live check on the day decides "kept"). A lead first
 * found on the day is added as such, ticked only when every detail puts it in
 * a removed place.
 */
export async function foldSightings(
  changeId: number, places: Place[], sightings: Sighting[],
  opts: { onlyExisting?: boolean; holder?: string } = {},
): Promise<{ hits: number }> {
  if (!sightings.length) return { hits: 0 };
  return serially(changeId, async () => {
    const c = (await db.execute({ sql: "SELECT status, lease_holder FROM sa_change WHERE id = ?", args: [changeId] })).rows[0];
    if (opts.holder && (!c || c.lease_holder !== opts.holder || !SCANNING.includes(String(c.status) as ChangeStatus))) throw new LeaseLost(changeId);
    const topup = c?.status === "topup";
    const byEmail = new Map<string, Sighting[]>();
    for (const s of sightings) {
      const e = normEmail(s.email);
      if (!e || !e.includes("@")) continue;
      if (!byEmail.has(e)) byEmail.set(e, []);
      byEmail.get(e)!.push(s);
    }
    const emails = [...byEmail.keys()];
    const existing = new Map<string, Row>();
    for (let i = 0; i < emails.length; i += 200) {
      const chunk = emails.slice(i, i + 200);
      const r = await db.execute({ sql: `SELECT * FROM sa_lead WHERE change_id = ? AND email IN (${chunk.map(() => "?").join(",")})`, args: [changeId, ...chunk] });
      for (const x of r.rows) existing.set(String(x.email), x as Row);
    }

    type Work = { email: string; raw: string[]; sig: Signals; view: ReturnType<typeof signalsOf>["view"]; name: string | null; company: string | null; replied: boolean; members: NonNullable<Sighting["member"]>[]; prev?: Row };
    const work: Work[] = [];
    const zips = new Set<string>();
    for (const p of places) if (p.zip) zips.add(p.zip);
    for (const [email, list] of byEmail) {
      const prev = existing.get(email);
      if (opts.onlyExisting && !prev) continue;
      let sig: Signals = prev ? JSON.parse(String(prev.signals_json)) : { cities: [], states: [], zips: [] };
      let view = { city: null as string | null, state: null as string | null, zip: null as string | null, address: null as string | null };
      for (const s of list) {
        const one = signalsOf(s.input);
        sig = mergeSignals(sig, one.signals);
        view = { city: view.city ?? one.view.city, state: view.state ?? one.view.state, zip: view.zip ?? one.view.zip, address: view.address ?? one.view.address };
      }
      sig.zips.forEach((z) => zips.add(z));
      const raw = new Set<string>(prev?.raw_emails ? JSON.parse(String(prev.raw_emails)) : []);
      for (const s of list) { const r = String(s.email || "").trim(); if (r && r !== email) raw.add(r); }
      work.push({
        email, raw: [...raw], sig, view, prev,
        name: list.map((s) => s.name).find((n) => n && n.trim()) ?? null,
        company: list.map((s) => s.company).find((c) => c && c.trim()) ?? null,
        replied: list.some((s) => s.replied),
        members: list.map((s) => s.member).filter((m): m is NonNullable<Sighting["member"]> => !!m),
      });
    }
    const facts = await zipFactsFor(zips);
    const cityStates = await cityStatesFor(places);
    const now = nowIso();
    const stmts: { sql: string; args: (string | number | null)[] }[] = [];
    let hits = 0;
    const memberStmt = (email: string, m: NonNullable<Sighting["member"]>) => ({
      sql: `INSERT INTO sa_member (change_id, email, instance, campaign_id, campaign_name, kind, lead_id, lead_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(change_id, email, instance, campaign_id, lead_id) DO UPDATE SET lead_status = excluded.lead_status, campaign_name = excluded.campaign_name`,
      args: [changeId, email, m.instance, m.campaignId, m.campaignName, m.kind, m.leadId, m.leadStatus],
    });
    for (const w of work) {
      if (topup && w.prev && !num(w.prev.found_on_day)) {
        // On the approved list: frozen. Only where it sits is added.
        for (const m of w.members) stmts.push(memberStmt(w.email, m));
        continue;
      }
      const v = classify(w.sig, places, facts, cityStates);
      if (v.cls === "out") {
        // A listed lead whose added signals put it outside every removed place.
        if (w.prev) {
          stmts.push({ sql: "DELETE FROM sa_lead WHERE change_id = ? AND email = ? AND decided_by IS NULL", args: [changeId, w.email] });
          stmts.push({ sql: "DELETE FROM sa_member WHERE change_id = ? AND email = ? AND NOT EXISTS (SELECT 1 FROM sa_lead WHERE change_id = ? AND email = ?)", args: [changeId, w.email, changeId, w.email] });
          // Ticked by hand: keep the row (the person's call) but record the new reading.
          stmts.push({ sql: "UPDATE sa_lead SET signals_json = ?, cls = 'check', reason = ?, updated_at = ? WHERE change_id = ? AND email = ?", args: [JSON.stringify(w.sig), "Its location details now point outside the removed places — set by hand earlier", now, changeId, w.email] });
        }
        continue;
      }
      hits++;
      const defaultRemove = v.cls === "match" ? 1 : 0;
      const pick = (k: string, nv: string | null) => (w.prev?.[k] ?? nv ?? null) as string | null;
      // The upsert never touches a lead on the approved list: on the removal day
      // the conflict only updates rows first found that day.
      stmts.push({
        sql: `INSERT INTO sa_lead (change_id, email, raw_emails, name, company, city, state, zip, address, signals_json, cls, place_key, reason, remove, replied, found_on_day, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(change_id, email) DO UPDATE SET raw_emails = excluded.raw_emails, name = excluded.name, company = excluded.company,
                city = excluded.city, state = excluded.state, zip = excluded.zip, address = excluded.address, signals_json = excluded.signals_json,
                cls = excluded.cls, place_key = excluded.place_key, reason = excluded.reason,
                remove = CASE WHEN sa_lead.decided_by IS NOT NULL THEN sa_lead.remove ELSE excluded.remove END,
                replied = MAX(sa_lead.replied, excluded.replied), updated_at = excluded.updated_at
              WHERE excluded.found_on_day = 0 OR sa_lead.found_on_day = 1`,
        args: [changeId, w.email, w.raw.length ? JSON.stringify(w.raw) : null, pick("name", w.name), pick("company", w.company), pick("city", w.view.city), pick("state", w.view.state),
          pick("zip", w.view.zip), pick("address", w.view.address), JSON.stringify(w.sig), v.cls, v.place, v.reason, defaultRemove, w.replied ? 1 : 0, topup ? 1 : 0, now],
      });
      for (const m of w.members) stmts.push(memberStmt(w.email, m));
    }
    for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80), "write");
    return { hits };
  });
}

/** Listed leads, in pages by email (for the enrichment and cross-check passes). */
export async function leadsPage(changeId: number, afterEmail: string, limit: number): Promise<Array<{ email: string; raw: string[]; xchecked: boolean; instances: string[] }>> {
  const r = await db.execute({ sql: "SELECT email, raw_emails, xchecked FROM sa_lead WHERE change_id = ? AND email > ? ORDER BY email LIMIT ?", args: [changeId, afterEmail, limit] });
  const emails = r.rows.map((x) => String(x.email));
  const inst = new Map<string, Set<string>>();
  if (emails.length) {
    const m = await db.execute({ sql: `SELECT email, instance FROM sa_member WHERE change_id = ? AND kind <> 'queue' AND email IN (${emails.map(() => "?").join(",")})`, args: [changeId, ...emails] });
    for (const x of m.rows) { const e = String(x.email); if (!inst.has(e)) inst.set(e, new Set()); inst.get(e)!.add(String(x.instance)); }
  }
  return r.rows.map((x) => ({
    email: String(x.email), raw: x.raw_emails ? JSON.parse(String(x.raw_emails)) : [], xchecked: num(x.xchecked) === 1,
    instances: [...(inst.get(String(x.email)) ?? [])],
  }));
}

export async function markXchecked(changeId: number, emails: string[]): Promise<void> {
  for (let i = 0; i < emails.length; i += 200) {
    const chunk = emails.slice(i, i + 200);
    await db.execute({ sql: `UPDATE sa_lead SET xchecked = 1 WHERE change_id = ? AND email IN (${chunk.map(() => "?").join(",")})`, args: [changeId, ...chunk] });
  }
}

// ── the review screen ────────────────────────────────────────────────────────

export type Tab = LeadClass | "ticked";
export interface LeadFilter { tab: Tab; q?: string; result?: string }

function filterSql(changeId: number, f: LeadFilter): { where: string; args: (string | number)[] } {
  const parts = ["change_id = ?"];
  const args: (string | number)[] = [changeId];
  if (f.tab === "ticked") parts.push("remove = 1");
  else { parts.push("cls = ?"); args.push(f.tab); }
  const q = String(f.q ?? "").trim().toLowerCase();
  if (q) {
    parts.push("(email LIKE ? OR LOWER(COALESCE(name, '')) LIKE ? OR LOWER(COALESCE(company, '')) LIKE ? OR LOWER(COALESCE(city, '')) LIKE ? OR LOWER(COALESCE(zip, '')) LIKE ?)");
    const like = `%${q}%`;
    args.push(like, like, like, like, like);
  }
  if (f.result === "failed") parts.push("result = 'failed'");
  return { where: parts.join(" AND "), args };
}

export interface LeadRow {
  email: string; name: string | null; company: string | null;
  city: string | null; state: string | null; zip: string | null; address: string | null;
  cls: LeadClass; placeKey: string | null; reason: string | null; remove: boolean; decidedBy: string | null; replied: boolean;
  result: LeadResult | null; resultDetail: string | null; foundOnDay: boolean;
  where: Array<{ instance: string; campaignId: number; campaignName: string | null; kind: MemberKind; leadStatus: string | null }>;
}

/**
 * One page of leads. Pages by position (`after` = the last row's sort key), not
 * by offset, so ticking / unticking on one page never shifts the next.
 */
export async function pageLeads(changeId: number, f: LeadFilter, after: [string, string, string] | null, size: number): Promise<{ rows: LeadRow[]; total: number; next: [string, string, string] | null }> {
  const { where, args } = filterSql(changeId, f);
  const total = num((await db.execute({ sql: `SELECT COUNT(*) AS n FROM sa_lead WHERE ${where}`, args })).rows[0]?.n);
  const keyed = after ? " AND (COALESCE(place_key, ''), COALESCE(city, ''), email) > (?, ?, ?)" : "";
  const r = await db.execute({
    sql: `SELECT * FROM sa_lead WHERE ${where}${keyed} ORDER BY COALESCE(place_key, ''), COALESCE(city, ''), email LIMIT ?`,
    args: [...args, ...(after ?? []), size],
  });
  const emails = r.rows.map((x) => String(x.email));
  const members = new Map<string, LeadRow["where"]>();
  if (emails.length) {
    const m = await db.execute({ sql: `SELECT * FROM sa_member WHERE change_id = ? AND email IN (${emails.map(() => "?").join(",")}) ORDER BY kind, campaign_name`, args: [changeId, ...emails] });
    for (const x of m.rows) {
      const e = String(x.email);
      if (!members.has(e)) members.set(e, []);
      members.get(e)!.push({ instance: String(x.instance), campaignId: num(x.campaign_id), campaignName: (x.campaign_name as string) ?? null, kind: String(x.kind) as MemberKind, leadStatus: (x.lead_status as string) ?? null });
    }
  }
  const last = r.rows[r.rows.length - 1];
  return {
    total,
    next: r.rows.length === size && last ? [String(last.place_key ?? ""), String(last.city ?? ""), String(last.email)] : null,
    rows: r.rows.map((x) => ({
      email: String(x.email), name: (x.name as string) ?? null, company: (x.company as string) ?? null,
      city: (x.city as string) ?? null, state: (x.state as string) ?? null, zip: (x.zip as string) ?? null, address: (x.address as string) ?? null,
      cls: String(x.cls) as LeadClass, placeKey: (x.place_key as string) ?? null, reason: (x.reason as string) ?? null,
      remove: num(x.remove) === 1, decidedBy: (x.decided_by as string) ?? null, replied: num(x.replied) === 1,
      result: (x.result as LeadResult) ?? null, resultDetail: (x.result_detail as string) ?? null, foundOnDay: num(x.found_on_day) === 1,
      where: members.get(String(x.email)) ?? [],
    })),
  };
}

// Ticks only change while the change is being checked or in review — checked in
// the same statement, so a tick can't slip in after approval.
const editableNow = `EXISTS (SELECT 1 FROM sa_change c WHERE c.id = ? AND c.status IN ('scanning', 'review'))`;

export async function setDecisions(changeId: number, emails: string[], remove: boolean, by: string | null): Promise<number> {
  const list = [...new Set(emails.map(normEmail).filter(Boolean))];
  let n = 0;
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const r = await db.execute({
      sql: `UPDATE sa_lead SET remove = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE change_id = ? AND email IN (${chunk.map(() => "?").join(",")}) AND ${editableNow}`,
      args: [remove ? 1 : 0, by ?? "someone", nowIso(), nowIso(), changeId, ...chunk, changeId],
    });
    n += r.rowsAffected ?? 0;
  }
  return n;
}

export async function countMatching(changeId: number, f: LeadFilter): Promise<number> {
  const { where, args } = filterSql(changeId, f);
  return num((await db.execute({ sql: `SELECT COUNT(*) AS n FROM sa_lead WHERE ${where}`, args })).rows[0]?.n);
}

export async function setDecisionsMatching(changeId: number, f: LeadFilter, remove: boolean, by: string | null): Promise<number> {
  const { where, args } = filterSql(changeId, f);
  const r = await db.execute({
    sql: `UPDATE sa_lead SET remove = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE ${where} AND ${editableNow}`,
    args: [remove ? 1 : 0, by ?? "someone", nowIso(), nowIso(), ...args, changeId],
  });
  return r.rowsAffected ?? 0;
}

export interface Counts {
  byClass: Record<LeadClass, { total: number; ticked: number }>;
  ticked: number;
  where: { main: number; nurture: number; queue: number; mainCampaigns: number; nurtureCampaigns: number };
  results: { removed: number; verified: number; failed: number; kept: number; letIn: number; pending: number };
}

export async function counts(changeId: number): Promise<Counts> {
  const byClass: Counts["byClass"] = { match: { total: 0, ticked: 0 }, check: { total: 0, ticked: 0 }, noloc: { total: 0, ticked: 0 }, out: { total: 0, ticked: 0 } };
  const c = await db.execute({ sql: "SELECT cls, COUNT(*) AS n, SUM(remove) AS t FROM sa_lead WHERE change_id = ? GROUP BY cls", args: [changeId] });
  let ticked = 0;
  for (const x of c.rows) { const k = String(x.cls) as LeadClass; if (byClass[k]) { byClass[k] = { total: num(x.n), ticked: num(x.t) }; ticked += num(x.t); } }
  const w = await db.execute({
    sql: `SELECT m.kind AS kind, COUNT(DISTINCT m.email) AS leads, COUNT(DISTINCT m.instance || ':' || m.campaign_id) AS camps
          FROM sa_member m JOIN sa_lead l ON l.change_id = m.change_id AND l.email = m.email
          WHERE m.change_id = ? AND l.remove = 1 GROUP BY m.kind`,
    args: [changeId],
  });
  const where = { main: 0, nurture: 0, queue: 0, mainCampaigns: 0, nurtureCampaigns: 0 };
  for (const x of w.rows) {
    if (x.kind === "main") { where.main = num(x.leads); where.mainCampaigns = num(x.camps); }
    else if (x.kind === "nurture") { where.nurture = num(x.leads); where.nurtureCampaigns = num(x.camps); }
    else if (x.kind === "queue") where.queue = num(x.leads);
  }
  const rs = await db.execute({ sql: "SELECT COALESCE(result, 'pending') AS r, COUNT(*) AS n FROM sa_lead WHERE change_id = ? AND remove = 1 GROUP BY 1", args: [changeId] });
  const results = { removed: 0, verified: 0, failed: 0, kept: 0, letIn: 0, pending: 0 };
  for (const x of rs.rows) {
    const k = String(x.r);
    if (k === "let_in") results.letIn = num(x.n);
    else if (k in results) results[k as "removed" | "verified" | "failed" | "kept" | "pending"] = num(x.n);
  }
  return { byClass, ticked, where, results };
}

// ── removal bookkeeping ──────────────────────────────────────────────────────

/** Ticked emails in pages; `stillGoing` leaves out leads kept on the day or let back in. */
export async function tickedEmails(changeId: number, afterEmail: string, limit: number, opts: { stillGoing?: boolean } = {}): Promise<string[]> {
  const going = opts.stillGoing ? " AND (result IS NULL OR result NOT IN ('kept', 'let_in'))" : "";
  const r = await db.execute({ sql: `SELECT email FROM sa_lead WHERE change_id = ? AND remove = 1${going} AND email > ? ORDER BY email LIMIT ?`, args: [changeId, afterEmail, limit] });
  return r.rows.map((x) => String(x.email));
}

/**
 * Ticked leads waiting for a step: `null` = not removed yet, `removed` = waiting
 * for the check, `verified` = for the re-check. `attempts` picks one round
 * exactly; `maxAttempts` caps retries, and a lead that just failed waits
 * `retryAfterMs` before it's tried again.
 */
export async function leadsAt(changeId: number, result: LeadResult | null, limit: number, opts: { maxAttempts?: number; attempts?: number; retryAfterMs?: number } = {}): Promise<Array<{ email: string; attempts: number; found: Found[]; signals: Signals; byHand: boolean }>> {
  const cond = result === null ? "result IS NULL" : "result = ?";
  const att = opts.attempts != null ? "attempts = ?" : "attempts < ?";
  const wait = opts.retryAfterMs ? " AND (attempts = 0 OR updated_at < ?)" : "";
  const r = await db.execute({
    sql: `SELECT email, attempts, found_json, signals_json, decided_by FROM sa_lead WHERE change_id = ? AND remove = 1 AND ${cond} AND ${att}${wait} ORDER BY attempts, email LIMIT ?`,
    args: [changeId, ...(result === null ? [] : [result]), opts.attempts ?? opts.maxAttempts ?? 99,
      ...(opts.retryAfterMs ? [new Date(Date.now() - opts.retryAfterMs).toISOString()] : []), limit],
  });
  return r.rows.map((x) => ({
    email: String(x.email), attempts: num(x.attempts), found: x.found_json ? JSON.parse(String(x.found_json)) : [],
    signals: JSON.parse(String(x.signals_json || '{"cities":[],"states":[],"zips":[]}')), byHand: x.decided_by != null,
  }));
}

/** Where a lead was found in Bison (instance + its lead id there + the client's campaigns it was in). */
export interface Found { instance: string; campaignId: number; leadId: number }

export async function setResults(changeId: number, updates: Array<{ email: string; result: LeadResult | null; detail?: string | null; found?: Found[]; bumpAttempts?: boolean; addAttempts?: number }>): Promise<void> {
  const now = nowIso();
  for (let i = 0; i < updates.length; i += 80) {
    await db.batch(updates.slice(i, i + 80).map((u) => ({
      sql: `UPDATE sa_lead SET result = ?, result_detail = CASE WHEN ? THEN ? ELSE result_detail END,
              found_json = CASE WHEN ? THEN ? ELSE found_json END, attempts = attempts + ?, updated_at = ?
            WHERE change_id = ? AND email = ? AND (result IS NULL OR result <> 'let_in')`,
      args: [u.result, u.detail !== undefined ? 1 : 0, u.detail ?? null, u.found ? 1 : 0, u.found ? JSON.stringify(u.found) : null, u.bumpAttempts ? (u.addAttempts ?? 1) : 0, now, changeId, u.email],
    })), "write");
  }
}

/** The client campaigns (instance, campaign, lead id) the scan saw each email in. */
export async function knownMemberships(changeId: number, emails: string[]): Promise<Map<string, Found[]>> {
  const out = new Map<string, Found[]>();
  for (let i = 0; i < emails.length; i += 200) {
    const chunk = emails.slice(i, i + 200);
    const r = await db.execute({ sql: `SELECT email, instance, campaign_id, lead_id FROM sa_member WHERE change_id = ? AND kind <> 'queue' AND email IN (${chunk.map(() => "?").join(",")})`, args: [changeId, ...chunk] });
    for (const x of r.rows) {
      const e = String(x.email);
      if (!out.has(e)) out.set(e, []);
      out.get(e)!.push({ instance: String(x.instance), campaignId: num(x.campaign_id), leadId: num(x.lead_id) });
    }
  }
  return out;
}

/** Reset the attempt counter for a step (verify and re-check start fresh). Leaves let-in leads alone. */
export async function resetAttempts(changeId: number): Promise<void> {
  await db.execute({ sql: "UPDATE sa_lead SET attempts = 0 WHERE change_id = ? AND remove = 1", args: [changeId] });
}
