/**
 * Lead Mover — durable job persistence (Turso). A "Migrate" click becomes one
 * `move_job` + one `move_job_task` per source campaign. A server runner leases a
 * job (heartbeat = single-runner lease), advances each task one window at a time
 * (persisting the cursor + counts after every window, so an interrupted runner
 * resumes from the saved cursor — never restarts), and finalizes the job. The
 * inbox/migrate UI and a global banner just poll a status view of these rows —
 * the run no longer lives in a browser tab.
 *
 * Mirrors the `lib/send-retry.ts` idiom (lazy ensureTable + `let ready`,
 * `db.execute({sql,args})`, status columns).
 */
import db from "@/lib/db";

export type MoveJobKind = "cross" | "same";
export type MoveJobStatus = "pending" | "running" | "done" | "failed" | "canceled";
export type MoveTaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

export const MAX_TASK_ATTEMPTS = 6; // window failures on a task before it's marked failed
const nowIso = () => new Date().toISOString();

let ready = false;
async function ensureTables(): Promise<void> {
  if (ready) return;
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
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_move_job_status ON move_job(status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_move_task_job ON move_job_task(job_id, status)`);
  // Added after the table's first release — safe to run repeatedly.
  try { await db.execute("ALTER TABLE move_job ADD COLUMN source_instance TEXT"); } catch { /* already exists */ }
  ready = true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const num = (v: unknown) => Number(v) || 0;

export interface NewTask {
  clientTag: string;
  sourceInstance: string;
  sourceCampaignId: number;
  sourceCampaignName: string;
  targetInstance?: string | null;   // cross
  b2bInstance?: string | null;      // same
  b2cInstance?: string | null;      // same
  dest: unknown;                    // cross: {esp→id}; same: {b2b:{…},b2c:{…}}
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
           target_instance, b2b_instance, b2c_instance, dest_json, service_area_filter, total_leads, status, error, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [crypto.randomUUID(), jobId, t.clientTag, t.sourceInstance, t.sourceCampaignId, t.sourceCampaignName,
          t.targetInstance ?? null, t.b2bInstance ?? null, t.b2cInstance ?? null, JSON.stringify(t.dest ?? {}),
          t.serviceAreaFilter ? 1 : 0, t.totalLeads || 0, t.status ?? "pending", t.error ?? null, now],
      })),
      "write",
    );
  }
  await recomputeJobRollups(jobId); // account for any pre-'skipped' tasks
  return jobId;
}

// ── Leasing (single-runner guarantee) ────────────────────────────────────────

/**
 * Atomically lease a job to run. A job is claimable if it's `pending`, or
 * `running` with a stale/absent heartbeat (its previous runner exited or died).
 * Enforces GLOBAL SERIAL execution — the claim fails if ANY OTHER job is
 * actively running (fresh heartbeat) — so two migrations never hammer Bison at
 * once. Prefers resuming a stale `running` job over starting a new `pending` one.
 * Pass `jobId` to target one (self-trigger/continuation). Returns the leased id
 * or null if none/lost-the-race/another-job-active.
 */
export async function leaseJob(staleMs: number, jobId?: string): Promise<string | null> {
  await ensureTables();
  const now = nowIso();
  const staleCutoff = new Date(Date.now() - staleMs).toISOString();
  const claimable = `(status='pending' OR (status='running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)))`;
  const pick = jobId
    ? await db.execute({ sql: `SELECT id FROM move_job WHERE id=? AND ${claimable} LIMIT 1`, args: [jobId, staleCutoff] })
    : await db.execute({ sql: `SELECT id FROM move_job WHERE ${claimable} ORDER BY (status='running') DESC, created_at ASC LIMIT 1`, args: [staleCutoff] });
  if (!pick.rows.length) return null;
  const id = String(pick.rows[0].id);
  const claim = await db.execute({
    sql: `UPDATE move_job SET status='running', started_at=COALESCE(started_at, ?), heartbeat_at=?, updated_at=?
          WHERE id=? AND ${claimable}
            AND NOT EXISTS (SELECT 1 FROM move_job x WHERE x.id <> ? AND x.status='running' AND x.heartbeat_at IS NOT NULL AND x.heartbeat_at >= ?)`,
    args: [now, now, now, id, staleCutoff, id, staleCutoff],
  });
  return (claim.rowsAffected ?? 0) > 0 ? id : null;
}

export async function heartbeat(jobId: string): Promise<void> {
  const now = nowIso();
  await db.execute({ sql: "UPDATE move_job SET heartbeat_at=?, updated_at=? WHERE id=? AND status='running'", args: [now, now, jobId] });
}

/** Graceful lease release on runner exit — clears the heartbeat so a self-trigger
 *  successor can immediately re-lease (instant continuation) instead of waiting
 *  out the stale window. Keeps status='running' (work still pending). */
export async function releaseJob(jobId: string): Promise<void> {
  await db.execute({ sql: "UPDATE move_job SET heartbeat_at=NULL, updated_at=? WHERE id=? AND status='running'", args: [nowIso(), jobId] });
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

export async function markTaskRunning(taskId: string): Promise<void> {
  await db.execute({ sql: "UPDATE move_job_task SET status='running', updated_at=? WHERE id=?", args: [nowIso(), taskId] });
}

export interface WindowOutcome {
  nextCursor: string | null; done: boolean;
  moved: number; skippedArea: number; skippedLane: number; skippedNoDest: number;
  movedByKey?: Record<string, number>; error?: string;
}

/** Persist one window's result onto a task (persist-then-advance). Increments
 *  counts, saves the cursor, and transitions status: done, failed (after
 *  MAX_TASK_ATTEMPTS window errors), or pending (keep going). */
export async function applyTaskWindow(taskId: string, o: WindowOutcome): Promise<void> {
  const cur = await db.execute({ sql: "SELECT attempts, moved_by_key_json FROM move_job_task WHERE id=?", args: [taskId] });
  if (!cur.rows.length) return;
  const prevAttempts = num(cur.rows[0].attempts);
  const attempts = o.error ? prevAttempts + 1 : prevAttempts;

  let mergedKeyJson: string | null = (cur.rows[0].moved_by_key_json as string) ?? null;
  if (o.movedByKey && Object.keys(o.movedByKey).length) {
    const prev: Record<string, number> = mergedKeyJson ? JSON.parse(mergedKeyJson) : {};
    for (const [k, n] of Object.entries(o.movedByKey)) prev[k] = (prev[k] || 0) + n;
    mergedKeyJson = JSON.stringify(prev);
  }

  const done = o.done && !o.error;
  const failed = !!o.error && attempts >= MAX_TASK_ATTEMPTS;
  const status: MoveTaskStatus = done ? "done" : failed ? "failed" : "pending";

  await db.execute({
    sql: `UPDATE move_job_task SET
        cursor=?, done=?, moved=moved+?, skipped_area=skipped_area+?, skipped_lane=skipped_lane+?, skipped_nodest=skipped_nodest+?,
        moved_by_key_json=?, attempts=?, status=?, error=?, updated_at=?
      WHERE id=?`,
    args: [
      o.nextCursor, done ? 1 : 0, o.moved, o.skippedArea, o.skippedLane, o.skippedNoDest,
      mergedKeyJson, attempts, status, o.error ?? null, nowIso(), taskId,
    ],
  });
}

/** Roll task counts up onto the job; finalize the job when no task is
 *  pending/running (unless it was canceled). Returns the (possibly new) status. */
export async function recomputeJobRollups(jobId: string): Promise<MoveJobStatus> {
  const agg = await db.execute({
    sql: `SELECT
        COUNT(*) AS total,
        SUM(moved) AS moved,
        SUM(skipped_area) AS sa, SUM(skipped_lane) AS sl, SUM(skipped_nodest) AS sn,
        SUM(CASE WHEN status IN ('done','skipped') THEN 1 ELSE 0 END) AS done_ish,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END) AS remaining
      FROM move_job_task WHERE job_id=?`,
    args: [jobId],
  });
  const a = agg.rows[0] || {};
  const remaining = num(a.remaining);
  const failed = num(a.failed);

  const jr = await db.execute({ sql: "SELECT status FROM move_job WHERE id=?", args: [jobId] });
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
        tasks_done=?, tasks_failed=?, moved_total=?, skipped_area_total=?, skipped_lane_total=?, skipped_nodest_total=?,
        status=?, finished_at=COALESCE(finished_at, ?), updated_at=?
      WHERE id=?`,
    args: [num(a.done_ish), failed, num(a.moved), num(a.sa), num(a.sl), num(a.sn), status, finishedAt, now, jobId],
  });
  return status;
}

export async function cancelJob(jobId: string): Promise<boolean> {
  await ensureTables();
  const now = nowIso();
  const r = await db.execute({
    sql: "UPDATE move_job SET status='canceled', finished_at=COALESCE(finished_at, ?), updated_at=? WHERE id=? AND status IN ('pending','running')",
    args: [now, now, jobId],
  });
  if ((r.rowsAffected ?? 0) > 0) {
    await db.execute({ sql: "UPDATE move_job_task SET status='canceled', updated_at=? WHERE job_id=? AND status IN ('pending','running')", args: [now, jobId] });
    return true;
  }
  return false;
}

/** Reset a failed task so the runner retries it from its saved cursor. */
export async function retryFailedTasks(jobId: string): Promise<number> {
  await ensureTables();
  const now = nowIso();
  const r = await db.execute({
    sql: "UPDATE move_job_task SET status='pending', attempts=0, error=NULL, updated_at=? WHERE job_id=? AND status='failed'",
    args: [now, jobId],
  });
  // reopen the job if it had finalized
  await db.execute({ sql: "UPDATE move_job SET status='pending', finished_at=NULL, updated_at=? WHERE id=? AND status IN ('failed','done')", args: [now, jobId] });
  return r.rowsAffected ?? 0;
}

// ── Status view (for polling) ────────────────────────────────────────────────

export interface JobStatusView {
  id: string; runId: string; kind: MoveJobKind; status: MoveJobStatus;
  sourceInstance: string | null; targetInstance: string | null;
  targetLabel: string | null; targetLane: string | null; createdBy: string | null;
  leadsTotal: number; movedTotal: number; skippedAreaTotal: number; skippedLaneTotal: number; skippedNoDestTotal: number;
  tasksTotal: number; tasksDone: number; tasksFailed: number;
  heartbeatAt: string | null; error: string | null; createdAt: string; finishedAt: string | null;
  tasks: Array<{
    clientTag: string; sourceCampaignName: string; sourceCampaignId: number;
    moved: number; skippedArea: number; skippedLane: number; skippedNoDest: number;
    movedByKey: Record<string, number> | null; totalLeads: number; done: boolean; status: MoveTaskStatus; error: string | null;
  }>;
}

function toJobView(j: Row, tasks: Row[]): JobStatusView {
  return {
    id: String(j.id), runId: String(j.run_id), kind: String(j.kind) as MoveJobKind, status: String(j.status) as MoveJobStatus,
    sourceInstance: j.source_instance ?? null, targetInstance: j.target_instance ?? null,
    targetLabel: j.target_label ?? null, targetLane: j.target_lane ?? null, createdBy: j.created_by ?? null,
    leadsTotal: num(j.leads_total), movedTotal: num(j.moved_total), skippedAreaTotal: num(j.skipped_area_total),
    skippedLaneTotal: num(j.skipped_lane_total), skippedNoDestTotal: num(j.skipped_nodest_total),
    tasksTotal: num(j.tasks_total), tasksDone: num(j.tasks_done), tasksFailed: num(j.tasks_failed),
    heartbeatAt: j.heartbeat_at ?? null, error: j.error ?? null, createdAt: String(j.created_at), finishedAt: j.finished_at ?? null,
    tasks: tasks.map((t) => ({
      clientTag: String(t.client_tag), sourceCampaignName: String(t.source_campaign_name), sourceCampaignId: num(t.source_campaign_id),
      moved: num(t.moved), skippedArea: num(t.skipped_area), skippedLane: num(t.skipped_lane), skippedNoDest: num(t.skipped_nodest),
      movedByKey: t.moved_by_key_json ? JSON.parse(String(t.moved_by_key_json)) : null,
      totalLeads: num(t.total_leads), done: num(t.done) === 1, status: String(t.status) as MoveTaskStatus, error: t.error ?? null,
    })),
  };
}

/** Jobs for the status endpoint. scope 'active' = pending/running only (global
 *  banner); otherwise active + recently-finished (last ~30 min). `jobId` scopes
 *  to one. */
export async function getStatusJobs(opts: { scope?: "active" | "all"; jobId?: string } = {}): Promise<JobStatusView[]> {
  await ensureTables();
  let jobs: Row[];
  if (opts.jobId) {
    jobs = (await db.execute({ sql: "SELECT * FROM move_job WHERE id=?", args: [opts.jobId] })).rows as Row[];
  } else if (opts.scope === "active") {
    jobs = (await db.execute({ sql: "SELECT * FROM move_job WHERE status IN ('pending','running') ORDER BY created_at DESC" })).rows as Row[];
  } else {
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    jobs = (await db.execute({
      sql: "SELECT * FROM move_job WHERE status IN ('pending','running') OR (finished_at IS NOT NULL AND finished_at > ?) ORDER BY created_at DESC LIMIT 25",
      args: [cutoff],
    })).rows as Row[];
  }
  const out: JobStatusView[] = [];
  for (const j of jobs) {
    const tasks = (await db.execute({ sql: "SELECT * FROM move_job_task WHERE job_id=? ORDER BY rowid ASC", args: [String(j.id)] })).rows as Row[];
    out.push(toJobView(j, tasks));
  }
  return out;
}
