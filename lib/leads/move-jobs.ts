/**
 * Lead Mover — durable job persistence (Turso). A "Migrate" click becomes one
 * `move_job` + one `move_job_task` per source campaign. A server runner leases a
 * job, advances each task one window at a time (persisting the cursor + counts
 * after every window, so an interrupted runner resumes from the saved cursor —
 * never restarts), and finalizes the job. The Move Leads page, the Jobs page and
 * the global banner just poll a status view of these rows.
 *
 * One runner per job, enforced: a lease carries a token (`lease_holder`), the
 * runner renews it on a timer, and every write of a window's results is fenced on
 * that token — a runner that lost its lease (or a cancelled job) can't add counts
 * twice. A window is also accepted only while its task's cursor is still where
 * the window started, so a write re-sent after a network blip (lib/db.ts retries
 * them) can't count twice either. Leads Bison refused one by one are kept in
 * `move_job_error` with the reason, shown under "Why?" and sent again by "Retry
 * errored"; the ones that then get through are counted from those rows (status
 * 'fixed', `moved_key`), never added to a task's counters.
 *
 * Mirrors the `lib/send-retry.ts` idiom (lazy ensureTable, `db.execute({sql,args})`,
 * status columns).
 */
import db from "@/lib/db";
import type { FailedLead } from "@/lib/leads/move-window";
import type { Candidate } from "@/lib/nurture/route-candidates";

export type MoveJobKind = "cross" | "same";
export type MoveJobStatus = "pending" | "running" | "done" | "failed" | "canceled";
export type MoveTaskStatus = "pending" | "running" | "done" | "failed" | "skipped" | "canceled";
export type MoveErrorStatus = "open" | "retrying" | "fixed" | "skipped";

export const MAX_TASK_ATTEMPTS = 6; // window failures in a row on a task before it's marked failed
/** Finished jobs stay listed this long (unless dismissed). */
export const HISTORY_DAYS = 30;
const nowIso = () => new Date().toISOString();
/** True when this runner still holds the job's lease (args: jobId, token). */
const FENCE = "(SELECT lease_holder FROM move_job WHERE id = ?) = ?";

let ready: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ready) ready = setUp().catch((e) => { ready = null; throw e; });
  return ready;
}
async function setUp(): Promise<void> {
  await db.execute(`CREATE TABLE IF NOT EXISTS move_job (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_by TEXT,
    source_instance TEXT,
    target_instance TEXT,
    target_label TEXT,
    target_lane TEXT,
    service_area_filter INTEGER NOT NULL DEFAULT 1,
    tasks_total INTEGER NOT NULL DEFAULT 0,
    tasks_done INTEGER NOT NULL DEFAULT 0,
    tasks_failed INTEGER NOT NULL DEFAULT 0,
    moved_total INTEGER NOT NULL DEFAULT 0,
    skipped_area_total INTEGER NOT NULL DEFAULT 0,
    skipped_lane_total INTEGER NOT NULL DEFAULT 0,
    skipped_nodest_total INTEGER NOT NULL DEFAULT 0,
    leads_total INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    heartbeat_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS move_job_task (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    client_tag TEXT NOT NULL,
    source_instance TEXT NOT NULL,
    source_campaign_id INTEGER NOT NULL,
    source_campaign_name TEXT NOT NULL,
    target_instance TEXT,
    b2b_instance TEXT,
    b2c_instance TEXT,
    dest_json TEXT NOT NULL,
    service_area_filter INTEGER NOT NULL DEFAULT 1,
    cursor TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    moved INTEGER NOT NULL DEFAULT 0,
    skipped_area INTEGER NOT NULL DEFAULT 0,
    skipped_lane INTEGER NOT NULL DEFAULT 0,
    skipped_nodest INTEGER NOT NULL DEFAULT 0,
    moved_by_key_json TEXT,
    total_leads INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    updated_at TEXT NOT NULL
  )`);
  // One row per lead that didn't reach its campaign (per job + source campaign): the reason, and the
  // lead as it was routed (candidate_json) so it can be sent again exactly.
  await db.execute(`CREATE TABLE IF NOT EXISTS move_job_error (
    job_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    client_tag TEXT NOT NULL,
    ob_lead_id INTEGER NOT NULL,
    email TEXT,
    target_campaign_id INTEGER,
    candidate_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    retryable INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'open',
    moved_key TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (job_id, task_id, ob_lead_id)
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_move_job_status ON move_job(status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_move_task_job ON move_job_task(job_id, status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_move_error_status ON move_job_error(job_id, status)`);
  // Columns added after the tables' first release.
  const add = async (table: string, cols: Record<string, string>) => {
    const have = new Set((await db.execute(`PRAGMA table_info(${table})`)).rows.map((r) => String(r.name)));
    for (const [name, def] of Object.entries(cols)) {
      if (have.has(name)) continue;
      try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`); }
      catch (e) { if (!/duplicate column/i.test((e as Error).message)) throw e; }
    }
  };
  await add("move_job", {
    source_instance: "TEXT", lease_holder: "TEXT", dismissed_at: "TEXT", dismissed_by: "TEXT",
    processed_total: "INTEGER NOT NULL DEFAULT 0", noemail_total: "INTEGER NOT NULL DEFAULT 0",
    suppressed_total: "INTEGER NOT NULL DEFAULT 0", errored_total: "INTEGER NOT NULL DEFAULT 0",
  });
  await add("move_job_task", {
    processed: "INTEGER NOT NULL DEFAULT 0", no_email: "INTEGER NOT NULL DEFAULT 0",
    suppressed: "INTEGER NOT NULL DEFAULT 0", dest_names_json: "TEXT", esp_guessed: "INTEGER NOT NULL DEFAULT 0",
  });
  await add("move_job_error", { moved_key: "TEXT" });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const num = (v: unknown) => Number(v) || 0;
const parse = <T>(v: unknown, fallback: T): T => { try { return v ? (JSON.parse(String(v)) as T) : fallback; } catch { return fallback; } };

export interface NewTask {
  clientTag: string;
  sourceInstance: string;
  sourceCampaignId: number;
  sourceCampaignName: string;
  targetInstance?: string | null;   // cross
  b2bInstance?: string | null;      // same
  b2cInstance?: string | null;      // same
  dest: unknown;                    // cross: {esp→id}; same: {b2b:{…},b2c:{…}}
  /** campaign id → name, for showing where leads went. */
  destNames?: Record<string, string> | null;
  serviceAreaFilter: boolean;
  totalLeads: number;
  status?: MoveTaskStatus;          // 'skipped' for no-destination entries
  error?: string | null;           // skip reason
}

export interface CreateJobInput {
  runId: string;
  kind: MoveJobKind;
  createdBy: string | null;
  sourceInstance: string | null;
  targetInstance: string | null;
  targetLabel: string | null;
  targetLane: string | null;
  serviceAreaFilter: boolean;
  tasks: NewTask[];
}

/** Create a job + its tasks. Idempotent on run_id (double-submit returns the
 *  existing job id). Returns the job id. */
export async function createJob(input: CreateJobInput): Promise<string> {
  await ensureTables();
  const existing = await db.execute({ sql: "SELECT id FROM move_job WHERE run_id = ? LIMIT 1", args: [input.runId] });
  if (existing.rows.length) return String(existing.rows[0].id);

  const now = nowIso();
  const jobId = crypto.randomUUID();
  const leadsTotal = input.tasks.reduce((s, t) => s + (t.totalLeads || 0), 0);
  const tasksTotal = input.tasks.length;
  await db.execute({
    sql: `INSERT INTO move_job
      (id, run_id, kind, status, created_by, source_instance, target_instance, target_label, target_lane, service_area_filter,
       tasks_total, leads_total, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [jobId, input.runId, input.kind, "pending", input.createdBy, input.sourceInstance, input.targetInstance, input.targetLabel, input.targetLane,
      input.serviceAreaFilter ? 1 : 0, tasksTotal, leadsTotal, now, now],
  });

  for (let i = 0; i < input.tasks.length; i += 50) {
    const chunk = input.tasks.slice(i, i + 50);
    await db.batch(
      chunk.map((t) => ({
        sql: `INSERT INTO move_job_task
          (id, job_id, client_tag, source_instance, source_campaign_id, source_campaign_name,
           target_instance, b2b_instance, b2c_instance, dest_json, dest_names_json, service_area_filter, total_leads, status, error, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [crypto.randomUUID(), jobId, t.clientTag, t.sourceInstance, t.sourceCampaignId, t.sourceCampaignName,
          t.targetInstance ?? null, t.b2bInstance ?? null, t.b2cInstance ?? null, JSON.stringify(t.dest ?? {}),
          t.destNames && Object.keys(t.destNames).length ? JSON.stringify(t.destNames) : null,
          t.serviceAreaFilter ? 1 : 0, t.totalLeads || 0, t.status ?? "pending", t.error ?? null, now],
      })),
      "write",
    );
  }
  await recomputeJobRollups(jobId); // account for any pre-'skipped' tasks
  return jobId;
}

// ── Leasing (single-runner guarantee) ────────────────────────────────────────

export interface Lease { id: string; token: string }

/**
 * Atomically lease a job to run. A job is claimable if it's `pending`, or
 * `running` with a stale/absent heartbeat (its previous runner exited or died).
 * Enforces GLOBAL SERIAL execution — the claim fails if ANY OTHER job is
 * actively running (fresh heartbeat) — so two migrations never hammer Bison at
 * once. Prefers resuming a stale `running` job over starting a new `pending` one.
 * Pass `jobId` to target one (self-trigger/continuation). Returns the lease (job
 * id + this runner's token) or null if none/lost-the-race/another-job-active.
 */
export async function leaseJob(staleMs: number, jobId?: string): Promise<Lease | null> {
  await ensureTables();
  const now = nowIso();
  const staleCutoff = new Date(Date.now() - staleMs).toISOString();
  const claimable = `(status='pending' OR (status='running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)))`;
  const pick = jobId
    ? await db.execute({ sql: `SELECT id FROM move_job WHERE id=? AND ${claimable} LIMIT 1`, args: [jobId, staleCutoff] })
    : await db.execute({ sql: `SELECT id FROM move_job WHERE ${claimable} ORDER BY (status='running') DESC, created_at ASC LIMIT 1`, args: [staleCutoff] });
  if (!pick.rows.length) return null;
  const id = String(pick.rows[0].id);
  const token = crypto.randomUUID();
  const claim = await db.execute({
    sql: `UPDATE move_job SET status='running', lease_holder=?, started_at=COALESCE(started_at, ?), heartbeat_at=?, updated_at=?
          WHERE id=? AND ${claimable}
            AND NOT EXISTS (SELECT 1 FROM move_job x WHERE x.id <> ? AND x.status='running' AND x.heartbeat_at IS NOT NULL AND x.heartbeat_at >= ?)`,
    args: [token, now, now, now, id, staleCutoff, id, staleCutoff],
  });
  return (claim.rowsAffected ?? 0) > 0 ? { id, token } : null;
}

/** Renew the lease. False when this runner no longer holds it (taken over, cancelled or finished). */
export async function heartbeat(jobId: string, token: string): Promise<boolean> {
  const now = nowIso();
  const r = await db.execute({
    sql: "UPDATE move_job SET heartbeat_at=?, updated_at=? WHERE id=? AND lease_holder=? AND status='running'",
    args: [now, now, jobId, token],
  });
  return (r.rowsAffected ?? 0) > 0;
}

/** Graceful lease release on runner exit — clears the heartbeat so a self-trigger
 *  successor can immediately re-lease (instant continuation) instead of waiting
 *  out the stale window. Keeps status='running' (work still pending). */
export async function releaseJob(jobId: string, token: string): Promise<void> {
  await db.execute({
    sql: "UPDATE move_job SET heartbeat_at=NULL, lease_holder=NULL, updated_at=? WHERE id=? AND lease_holder=? AND status='running'",
    args: [nowIso(), jobId, token],
  });
}

export async function getJobStatus(jobId: string): Promise<MoveJobStatus | null> {
  const r = await db.execute({ sql: "SELECT status FROM move_job WHERE id=?", args: [jobId] });
  return r.rows.length ? (String(r.rows[0].status) as MoveJobStatus) : null;
}

// ── Task processing ──────────────────────────────────────────────────────────

export interface TaskForRun {
  id: string; jobId: string; clientTag: string;
  sourceInstance: string; sourceCampaignId: number; sourceCampaignName: string;
  targetInstance: string | null; b2bInstance: string | null; b2cInstance: string | null;
  dest: unknown; serviceAreaFilter: boolean; cursor: string | null; attempts: number;
}

function toTaskForRun(r: Row): TaskForRun {
  return {
    id: String(r.id), jobId: String(r.job_id), clientTag: String(r.client_tag),
    sourceInstance: String(r.source_instance), sourceCampaignId: num(r.source_campaign_id), sourceCampaignName: String(r.source_campaign_name),
    targetInstance: r.target_instance ?? null, b2bInstance: r.b2b_instance ?? null, b2cInstance: r.b2c_instance ?? null,
    dest: JSON.parse(String(r.dest_json || "{}")), serviceAreaFilter: num(r.service_area_filter) === 1,
    cursor: r.cursor ?? null, attempts: num(r.attempts),
  };
}

/** Not-yet-terminal tasks for a job (pending/running, not done). */
export async function getLeasableTasks(jobId: string, limit: number): Promise<TaskForRun[]> {
  const r = await db.execute({
    sql: `SELECT * FROM move_job_task WHERE job_id=? AND done=0 AND status IN ('pending','running') ORDER BY rowid ASC LIMIT ?`,
    args: [jobId, limit],
  });
  return r.rows.map(toTaskForRun);
}

export async function markTaskRunning(taskId: string, jobId: string, token: string): Promise<void> {
  await db.execute({
    sql: `UPDATE move_job_task SET status='running', updated_at=? WHERE id=? AND status IN ('pending','running') AND ${FENCE}`,
    args: [nowIso(), taskId, jobId, token],
  });
}

export interface WindowOutcome {
  nextCursor: string | null; done: boolean;
  processed: number; moved: number; skippedArea: number; skippedLane: number; skippedNoDest: number;
  noEmail: number; suppressed: number; espGuessed: number;
  movedByKey?: Record<string, number>; failed?: FailedLead[]; error?: string;
}

const mergeKeys = (prevJson: unknown, add: Record<string, number> | undefined): string | null => {
  const prev = parse<Record<string, number>>(prevJson, {});
  if (!add || !Object.keys(add).length) return prevJson ? String(prevJson) : null;
  for (const [k, n] of Object.entries(add)) prev[k] = (prev[k] || 0) + n;
  return JSON.stringify(prev);
};

/** The failed leads of one window as fenced upserts (100 rows a statement). */
function errorUpserts(jobId: string, token: string, taskId: string, clientTag: string, failed: FailedLead[], now: string) {
  const out: Array<{ sql: string; args: (string | number | null)[] }> = [];
  for (let i = 0; i < failed.length; i += 100) {
    const chunk = failed.slice(i, i + 100);
    out.push({
      sql: `INSERT INTO move_job_error
          (job_id, task_id, client_tag, ob_lead_id, email, target_campaign_id, candidate_json, reason, retryable, status, attempts, created_at, updated_at)
        SELECT column1, column2, column3, column4, column5, column6, column7, column8, column9, 'open', 1, column10, column10
        FROM (VALUES ${chunk.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",")})
        WHERE ${FENCE}
        ON CONFLICT(job_id, task_id, ob_lead_id) DO UPDATE SET
          reason=excluded.reason, retryable=excluded.retryable, candidate_json=excluded.candidate_json,
          target_campaign_id=excluded.target_campaign_id, status='open', attempts=move_job_error.attempts+1, updated_at=excluded.updated_at`,
      args: [
        ...chunk.flatMap((f) => [jobId, taskId, clientTag, f.obLeadId, f.email, f.campaignId || null, JSON.stringify(f.candidate), f.reason.slice(0, 500), f.retryable ? 1 : 0, now]),
        jobId, token,
      ],
    });
  }
  return out;
}

/**
 * Persist one window's result onto a task (persist-then-advance): counts, cursor and the window's failed leads
 * in ONE transaction, only while this runner holds the lease and only if the task's cursor is still the one
 * the window started from (`task.cursor`). Status: done, failed (after
 * MAX_TASK_ATTEMPTS window errors in a row), or pending (keep going); a cancelled task stays cancelled.
 * Returns false when it wasn't written (lease lost, or already applied).
 */
export async function applyTaskWindow(task: { id: string; cursor: string | null }, jobId: string, token: string, o: WindowOutcome): Promise<boolean> {
  const taskId = task.id;
  const cur = await db.execute({ sql: "SELECT attempts, moved_by_key_json, client_tag FROM move_job_task WHERE id=?", args: [taskId] });
  if (!cur.rows.length) return false;
  const attempts = o.error ? num(cur.rows[0].attempts) + 1 : 0;
  const done = o.done && !o.error;
  const failed = !!o.error && attempts >= MAX_TASK_ATTEMPTS;
  const status: MoveTaskStatus = done ? "done" : failed ? "failed" : "pending";
  const now = nowIso();

  const results = await db.batch([
    {
      sql: `UPDATE move_job_task SET
          cursor=?, done=?, processed=processed+?, moved=moved+?, skipped_area=skipped_area+?, skipped_lane=skipped_lane+?, skipped_nodest=skipped_nodest+?,
          no_email=no_email+?, suppressed=suppressed+?, esp_guessed=esp_guessed+?, moved_by_key_json=?, attempts=?,
          status=CASE WHEN status='canceled' THEN 'canceled' ELSE ? END, error=?, updated_at=?
        WHERE id=? AND cursor IS ? AND done=0 AND ${FENCE}`,
      args: [
        o.nextCursor, done ? 1 : 0, o.processed, o.moved, o.skippedArea, o.skippedLane, o.skippedNoDest,
        o.noEmail, o.suppressed, o.espGuessed, mergeKeys(cur.rows[0].moved_by_key_json, o.movedByKey), attempts,
        status, o.error ?? null, now, taskId, task.cursor, jobId, token,
      ],
    },
    ...errorUpserts(jobId, token, taskId, String(cur.rows[0].client_tag), o.failed ?? [], now),
  ], "write");
  return (results[0].rowsAffected ?? 0) > 0;
}

/** Roll task counts up onto the job; finalize the job when no task is
 *  pending/running and no lead is waiting to be sent again (unless it was
 *  canceled). Returns the (possibly new) status. */
export async function recomputeJobRollups(jobId: string): Promise<MoveJobStatus> {
  const [agg, errs, jr] = await Promise.all([
    db.execute({
      sql: `SELECT
          COUNT(*) AS total,
          SUM(moved) AS moved, SUM(processed) AS processed,
          SUM(skipped_area) AS sa, SUM(skipped_lane) AS sl, SUM(skipped_nodest) AS sn, SUM(no_email) AS ne, SUM(suppressed) AS sup,
          SUM(CASE WHEN status IN ('done','skipped') THEN 1 ELSE 0 END) AS done_ish,
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END) AS remaining
        FROM move_job_task WHERE job_id=?`,
      args: [jobId],
    }),
    db.execute({
      sql: `SELECT SUM(CASE WHEN status IN ('open','retrying') THEN 1 ELSE 0 END) AS errored,
              SUM(CASE WHEN status='retrying' THEN 1 ELSE 0 END) AS retrying,
              SUM(CASE WHEN status='fixed' THEN 1 ELSE 0 END) AS fixed,
              SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS left_out
            FROM move_job_error WHERE job_id=?`,
      args: [jobId],
    }),
    db.execute({ sql: "SELECT status FROM move_job WHERE id=?", args: [jobId] }),
  ]);
  const a = agg.rows[0] || {};
  const e = errs.rows[0] || {};
  const remaining = num(a.remaining) + num(e.retrying);
  const failed = num(a.failed);
  const curStatus = jr.rows.length ? String(jr.rows[0].status) : "pending";
  const now = nowIso();

  let status = curStatus as MoveJobStatus;
  let finishedAt: string | null = null;
  if (curStatus !== "canceled" && remaining === 0) {
    status = failed > 0 ? "failed" : "done";
    finishedAt = now;
  }

  await db.execute({
    sql: `UPDATE move_job SET
        tasks_done=?, tasks_failed=?, moved_total=?, processed_total=?, skipped_area_total=?, skipped_lane_total=?, skipped_nodest_total=?,
        noemail_total=?, suppressed_total=?, errored_total=?,
        status=?, lease_holder=CASE WHEN ? IN ('done','failed') THEN NULL ELSE lease_holder END,
        finished_at=COALESCE(finished_at, ?), updated_at=?
      WHERE id=?`,
    args: [num(a.done_ish), failed, num(a.moved) + num(e.fixed), num(a.processed), num(a.sa), num(a.sl), num(a.sn),
      num(a.ne), num(a.sup) + num(e.left_out), num(e.errored), status, status, finishedAt, now, jobId],
  });
  return status;
}

export async function cancelJob(jobId: string): Promise<boolean> {
  await ensureTables();
  const now = nowIso();
  const r = await db.execute({
    sql: "UPDATE move_job SET status='canceled', lease_holder=NULL, finished_at=COALESCE(finished_at, ?), updated_at=? WHERE id=? AND status IN ('pending','running')",
    args: [now, now, jobId],
  });
  if ((r.rowsAffected ?? 0) > 0) {
    await db.batch([
      { sql: "UPDATE move_job_task SET status='canceled', updated_at=? WHERE job_id=? AND status IN ('pending','running')", args: [now, jobId] },
      { sql: "UPDATE move_job_error SET status='open', updated_at=? WHERE job_id=? AND status='retrying'", args: [now, jobId] },
    ], "write");
    await recomputeJobRollups(jobId);
    return true;
  }
  return false;
}

/**
 * "Retry errored": failed tasks go back to pending (from their saved cursor) and every lead that errored (and
 * can be retried) is queued to be sent again. Reopens a finished job so the runner picks it up. A cancelled job
 * isn't reopened.
 */
export async function retryJob(jobId: string): Promise<{ tasks: number; leads: number }> {
  await ensureTables();
  const now = nowIso();
  const st = await getJobStatus(jobId);
  if (!st || st === "canceled") return { tasks: 0, leads: 0 };
  const [t, e] = await db.batch([
    { sql: "UPDATE move_job_task SET status='pending', attempts=0, error=NULL, updated_at=? WHERE job_id=? AND status='failed'", args: [now, jobId] },
    { sql: "UPDATE move_job_error SET status='retrying', updated_at=? WHERE job_id=? AND status='open' AND retryable=1", args: [now, jobId] },
  ], "write");
  const tasks = t.rowsAffected ?? 0, leads = e.rowsAffected ?? 0;
  if (tasks + leads > 0) {
    await db.execute({
      sql: "UPDATE move_job SET status='pending', finished_at=NULL, dismissed_at=NULL, updated_at=? WHERE id=? AND status IN ('failed','done')",
      args: [now, jobId],
    });
    await recomputeJobRollups(jobId);
  }
  return { tasks, leads };
}

/** "Retry all errors": retryJob for every finished job in the history that has something to retry. */
export async function retryAllJobs(): Promise<{ jobs: number; tasks: number; leads: number }> {
  await ensureTables();
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();
  const ids = (await db.execute({
    sql: `SELECT j.id FROM move_job j WHERE j.status IN ('done','failed') AND j.created_at > ? AND j.dismissed_at IS NULL
            AND (j.tasks_failed > 0 OR EXISTS (SELECT 1 FROM move_job_error e WHERE e.job_id = j.id AND e.status='open' AND e.retryable=1))`,
    args: [cutoff],
  })).rows.map((r) => String(r.id));
  let tasks = 0, leads = 0, jobs = 0;
  for (const id of ids) {
    const r = await retryJob(id);
    if (r.tasks + r.leads > 0) { jobs++; tasks += r.tasks; leads += r.leads; }
  }
  return { jobs, tasks, leads };
}

// ── Sending failed leads again (runner) ──────────────────────────────────────

export interface RetryRow {
  key: string; taskId: string; obLeadId: number; clientTag: string; sourceInstance: string; sourceCampaignId: number;
  campaignId: number; candidate: Candidate;
}

export async function getRetryBatch(jobId: string, limit: number): Promise<RetryRow[]> {
  const r = await db.execute({
    sql: `SELECT e.task_id, e.ob_lead_id, e.candidate_json, e.target_campaign_id, t.client_tag, t.source_instance, t.source_campaign_id
          FROM move_job_error e JOIN move_job_task t ON t.id = e.task_id
          WHERE e.job_id=? AND e.status='retrying' LIMIT ?`,
    args: [jobId, limit],
  });
  return r.rows.map((x) => ({
    key: `${x.task_id}|${x.ob_lead_id}`, taskId: String(x.task_id), obLeadId: num(x.ob_lead_id),
    clientTag: String(x.client_tag), sourceInstance: String(x.source_instance), sourceCampaignId: num(x.source_campaign_id),
    campaignId: num(x.target_campaign_id), candidate: JSON.parse(String(x.candidate_json)) as Candidate,
  }));
}

/**
 * Record what sending leads again did, fenced like a window: moved → fixed (with the lane:esp it reached, so
 * it's counted as moved), failed again → open with the new reason, left out (removed for a service-area change
 * since) → skipped. Each update only touches rows still 'retrying', so a re-sent batch changes nothing twice.
 * Returns false when the lease was lost — nothing was written.
 */
export async function applyRetryOutcome(
  jobId: string, token: string, rows: RetryRow[],
  o: { moved: Map<string, string>; failed: Map<string, string>; left: Set<string> },
): Promise<boolean> {
  if (!rows.length) return true;
  const now = nowIso();
  const stmts: Array<{ sql: string; args: (string | number | null)[] }> = [
    // First, so the batch's first result says whether the lease held.
    { sql: `UPDATE move_job SET updated_at=? WHERE id=? AND ${FENCE}`, args: [now, jobId, jobId, token] },
  ];
  // Rows grouped by what they become: [status, reason, moved_key] → (task → lead ids).
  const groups = new Map<string, { status: MoveErrorStatus; reason: string | null; key: string | null; byTask: Map<string, number[]> }>();
  const put = (r: RetryRow, status: MoveErrorStatus, reason: string | null, key: string | null) => {
    const g = `${status}|${reason ?? ""}|${key ?? ""}`;
    if (!groups.has(g)) groups.set(g, { status, reason, key, byTask: new Map() });
    const bt = groups.get(g)!.byTask;
    if (!bt.has(r.taskId)) bt.set(r.taskId, []);
    bt.get(r.taskId)!.push(r.obLeadId);
  };
  for (const r of rows) {
    if (o.moved.has(r.key)) put(r, "fixed", null, o.moved.get(r.key)!);
    else if (o.left.has(r.key)) put(r, "skipped", "left out — removed for a service-area change", null);
    else put(r, "open", (o.failed.get(r.key) ?? "not sent").slice(0, 500), null);
  }
  for (const g of groups.values()) {
    for (const [taskId, ids] of g.byTask) {
      stmts.push({
        sql: `UPDATE move_job_error SET status=?, reason=COALESCE(?, reason), moved_key=COALESCE(?, moved_key), attempts=attempts+?, updated_at=?
              WHERE job_id=? AND task_id=? AND status='retrying' AND ob_lead_id IN (${ids.map(() => "?").join(",")}) AND ${FENCE}`,
        args: [g.status, g.reason, g.key, g.status === "open" ? 1 : 0, now, jobId, taskId, ...ids, jobId, token],
      });
    }
  }
  const res = await db.batch(stmts, "write");
  return (res[0].rowsAffected ?? 0) > 0;
}

// ── Status view (for polling) ────────────────────────────────────────────────

export interface TaskStatusView {
  id: string; clientTag: string; sourceInstance: string; sourceCampaignName: string; sourceCampaignId: number;
  targetInstance: string | null; b2bInstance: string | null; b2cInstance: string | null;
  processed: number; moved: number; skippedArea: number; skippedLane: number; skippedNoDest: number; noEmail: number; suppressed: number;
  espGuessed: number; errored: number; retryable: number; retrying: number;
  movedByKey: Record<string, number> | null; dest: unknown; destNames: Record<string, string> | null;
  totalLeads: number; done: boolean; status: MoveTaskStatus; error: string | null;
}

export interface JobStatusView {
  id: string; runId: string; kind: MoveJobKind; status: MoveJobStatus;
  sourceInstance: string | null; targetInstance: string | null;
  targetLabel: string | null; targetLane: string | null; createdBy: string | null; serviceAreaFilter: boolean;
  leadsTotal: number; processedTotal: number; movedTotal: number; skippedAreaTotal: number; skippedLaneTotal: number; skippedNoDestTotal: number;
  noEmailTotal: number; suppressedTotal: number; erroredTotal: number; retryableTotal: number; retryingTotal: number; espGuessedTotal: number;
  tasksTotal: number; tasksDone: number; tasksFailed: number;
  /** Counted before 2026-10-24: no per-lead accounting, and `movedTotal` can be too high. */
  legacy: boolean;
  heartbeatAt: string | null; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
  tasks: TaskStatusView[];
}

/** A task's moved-by-key plus the leads that got through on a retry. */
function mergeFixed(byKey: Record<string, number> | null, fixed: Record<string, number>): Record<string, number> {
  const out = { ...(byKey ?? {}) };
  for (const [k, n] of Object.entries(fixed)) out[k] = (out[k] || 0) + n;
  return out;
}

interface ErrCounts { errored: number; retryable: number; retrying: number; fixed: number; leftOut: number; fixedByKey: Record<string, number> }

function toJobView(j: Row, tasks: Row[], errs: Map<string, ErrCounts>): JobStatusView {
  const taskViews: TaskStatusView[] = tasks.map((t) => {
    const e = errs.get(String(t.id));
    const byKey = parse<Record<string, number> | null>(t.moved_by_key_json, null);
    return {
      id: String(t.id), clientTag: String(t.client_tag), sourceInstance: String(t.source_instance ?? ""),
      sourceCampaignName: String(t.source_campaign_name), sourceCampaignId: num(t.source_campaign_id),
      targetInstance: t.target_instance ?? null, b2bInstance: t.b2b_instance ?? null, b2cInstance: t.b2c_instance ?? null,
      processed: num(t.processed), moved: num(t.moved) + (e?.fixed ?? 0), skippedArea: num(t.skipped_area), skippedLane: num(t.skipped_lane),
      skippedNoDest: num(t.skipped_nodest), noEmail: num(t.no_email), suppressed: num(t.suppressed) + (e?.leftOut ?? 0), espGuessed: num(t.esp_guessed),
      errored: e?.errored ?? 0, retryable: e?.retryable ?? 0, retrying: e?.retrying ?? 0,
      movedByKey: e && Object.keys(e.fixedByKey).length ? mergeFixed(byKey, e.fixedByKey) : byKey, dest: parse<unknown>(t.dest_json, {}),
      destNames: parse<Record<string, string> | null>(t.dest_names_json, null),
      totalLeads: num(t.total_leads), done: num(t.done) === 1, status: String(t.status) as MoveTaskStatus, error: t.error ?? null,
    };
  });
  const sum = (f: (t: TaskStatusView) => number) => taskViews.reduce((s, t) => s + f(t), 0);
  return {
    id: String(j.id), runId: String(j.run_id), kind: String(j.kind) as MoveJobKind, status: String(j.status) as MoveJobStatus,
    sourceInstance: j.source_instance ?? null, targetInstance: j.target_instance ?? null,
    targetLabel: j.target_label ?? null, targetLane: j.target_lane ?? null, createdBy: j.created_by ?? null,
    serviceAreaFilter: num(j.service_area_filter) === 1,
    leadsTotal: num(j.leads_total), processedTotal: num(j.processed_total), movedTotal: num(j.moved_total),
    skippedAreaTotal: num(j.skipped_area_total), skippedLaneTotal: num(j.skipped_lane_total), skippedNoDestTotal: num(j.skipped_nodest_total),
    noEmailTotal: num(j.noemail_total), suppressedTotal: num(j.suppressed_total), erroredTotal: num(j.errored_total),
    retryableTotal: sum((t) => t.retryable), retryingTotal: sum((t) => t.retrying), espGuessedTotal: sum((t) => t.espGuessed),
    tasksTotal: num(j.tasks_total), tasksDone: num(j.tasks_done), tasksFailed: num(j.tasks_failed),
    legacy: num(j.processed_total) === 0 && num(j.moved_total) > 0,
    heartbeatAt: j.heartbeat_at ?? null, error: j.error ?? null, createdAt: String(j.created_at),
    startedAt: j.started_at ?? null, finishedAt: j.finished_at ?? null,
    tasks: taskViews,
  };
}

/** Jobs for the status endpoint. scope 'active' = pending/running only (global
 *  banner); otherwise active + the last HISTORY_DAYS days not dismissed (newest
 *  first, up to 50). `jobId` scopes to one. */
export async function getStatusJobs(opts: { scope?: "active" | "all"; jobId?: string } = {}): Promise<JobStatusView[]> {
  await ensureTables();
  let jobs: Row[];
  if (opts.jobId) {
    jobs = (await db.execute({ sql: "SELECT * FROM move_job WHERE id=?", args: [opts.jobId] })).rows as Row[];
  } else if (opts.scope === "active") {
    jobs = (await db.execute({ sql: "SELECT * FROM move_job WHERE status IN ('pending','running') ORDER BY created_at DESC" })).rows as Row[];
  } else {
    const cutoff = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();
    jobs = (await db.execute({
      sql: `SELECT * FROM move_job WHERE status IN ('pending','running') OR (created_at > ? AND dismissed_at IS NULL)
            ORDER BY created_at DESC LIMIT 50`,
      args: [cutoff],
    })).rows as Row[];
  }
  if (!jobs.length) return [];
  const ids = jobs.map((j) => String(j.id));
  const ph = ids.map(() => "?").join(",");
  const [tasks, errs] = await Promise.all([
    db.execute({ sql: `SELECT * FROM move_job_task WHERE job_id IN (${ph}) ORDER BY rowid ASC`, args: ids }),
    db.execute({
      sql: `SELECT task_id, moved_key,
              SUM(CASE WHEN status IN ('open','retrying') THEN 1 ELSE 0 END) AS errored,
              SUM(CASE WHEN status='open' AND retryable=1 THEN 1 ELSE 0 END) AS retryable,
              SUM(CASE WHEN status='retrying' THEN 1 ELSE 0 END) AS retrying,
              SUM(CASE WHEN status='fixed' THEN 1 ELSE 0 END) AS fixed,
              SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS left_out
            FROM move_job_error WHERE job_id IN (${ph}) GROUP BY task_id, moved_key`,
      args: ids,
    }),
  ]);
  const byJob = new Map<string, Row[]>();
  for (const t of tasks.rows as Row[]) { const k = String(t.job_id); if (!byJob.has(k)) byJob.set(k, []); byJob.get(k)!.push(t); }
  const errByTask = new Map<string, ErrCounts>();
  for (const e of errs.rows as Row[]) {
    const k = String(e.task_id);
    const c = errByTask.get(k) ?? { errored: 0, retryable: 0, retrying: 0, fixed: 0, leftOut: 0, fixedByKey: {} };
    c.errored += num(e.errored); c.retryable += num(e.retryable); c.retrying += num(e.retrying);
    c.fixed += num(e.fixed); c.leftOut += num(e.left_out);
    if (e.moved_key && num(e.fixed)) c.fixedByKey[String(e.moved_key)] = (c.fixedByKey[String(e.moved_key)] || 0) + num(e.fixed);
    errByTask.set(k, c);
  }
  return jobs.map((j) => toJobView(j, byJob.get(String(j.id)) ?? [], errByTask));
}

/** Hide a finished job from the lists (for everyone). A running or queued job can't be hidden. */
export async function dismissJob(jobId: string, by: string | null): Promise<boolean> {
  await ensureTables();
  const r = await db.execute({
    sql: "UPDATE move_job SET dismissed_at=?, dismissed_by=? WHERE id=? AND status NOT IN ('pending','running')",
    args: [nowIso(), by, jobId],
  });
  return (r.rowsAffected ?? 0) > 0;
}

export interface JobErrorGroup { reason: string; count: number; retryable: boolean; status: MoveErrorStatus; samples: string[] }

/** "Why?": the job's unsent leads grouped by reason (most first), with a few example emails each. */
export async function getJobErrors(jobId: string): Promise<JobErrorGroup[]> {
  await ensureTables();
  const groups = (await db.execute({
    sql: `SELECT reason, retryable, status, COUNT(*) AS n FROM move_job_error
          WHERE job_id=? AND status IN ('open','retrying','skipped') GROUP BY reason, retryable, status ORDER BY n DESC LIMIT 25`,
    args: [jobId],
  })).rows;
  const out: JobErrorGroup[] = [];
  for (const g of groups) {
    const samples = (await db.execute({
      sql: "SELECT email FROM move_job_error WHERE job_id=? AND reason=? AND status=? LIMIT 3",
      args: [jobId, String(g.reason), String(g.status)],
    })).rows.map((r) => String(r.email ?? ""));
    out.push({ reason: String(g.reason), count: num(g.n), retryable: num(g.retryable) === 1, status: String(g.status) as MoveErrorStatus, samples });
  }
  return out;
}

/** Every unsent lead of a job, for the CSV download (paged by the caller). */
export async function getJobErrorRows(jobId: string, afterRowid: number, limit: number): Promise<Row[]> {
  await ensureTables();
  return (await db.execute({
    sql: `SELECT e.rowid AS rid, t.client_tag, t.source_campaign_name, e.email, e.ob_lead_id, e.reason, e.status, e.attempts, e.updated_at
          FROM move_job_error e JOIN move_job_task t ON t.id = e.task_id
          WHERE e.job_id=? AND e.status IN ('open','retrying','skipped') AND e.rowid > ? ORDER BY e.rowid LIMIT ?`,
    args: [jobId, afterRowid, limit],
  })).rows as Row[];
}
