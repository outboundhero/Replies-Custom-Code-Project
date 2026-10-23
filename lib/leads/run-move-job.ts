/**
 * Lead Mover — server-side job runner. Leases a job (single-runner lease),
 * advances its tasks one small window at a time (concurrency mirrors the old
 * browser client pool), persisting cursor + counts after EVERY window so an
 * interrupted invocation resumes from the saved cursor (never restarts). Bounded
 * by `deadlineMs` (< 300s); when the budget runs out with work remaining it
 * releases its lease and self-triggers the cron so the job keeps moving back-to-
 * back. A scheduled cron is the durable backstop that resumes any stalled job.
 *
 * The lease is renewed on a timer (a window can run long — Bison's rate limit
 * makes it wait), so a busy runner is never mistaken for a dead one; every write
 * is fenced on the lease, and a runner that lost it stops. When every campaign is
 * done, leads queued by "Retry errored" are sent again, a batch per round.
 */
import db from "@/lib/db";
import { logError } from "@/lib/errors";
import { moveCrossWindow, moveSameWindow, retryFailedLeads } from "@/lib/leads/move-window";
import * as jobs from "@/lib/leads/move-jobs";

const CLIENT_CONCURRENCY = 6;   // tasks processed at once — mirrors the old client pool
const PER_WINDOW_MS = 45_000;   // per-task window budget; small so tasks cycle often
export const LEASE_STALE_MS = 90_000; // a running job with no heartbeat for this long is resumable
const HEARTBEAT_MS = 20_000;    // well inside LEASE_STALE_MS, however long a window takes
const RETRY_BATCH = 400;        // failed leads sent again per round

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

function baseUrl(): string {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return host ? `https://${host}` : "http://localhost:3000";
}

/** Fire-and-forget dispatch to the runner cron (dispatch only; we don't await the
 *  work). With a jobId it continues that job; without, it sweeps the next job. */
export function triggerRunner(jobId?: string): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const url = `${baseUrl()}/api/cron/run-move-jobs${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ""}`;
  fetch(url, { headers: { "x-cron-secret": secret }, signal: AbortSignal.timeout(3000) }).catch(() => {});
}

function sumVals(o: Record<string, number>): number {
  return Object.values(o).reduce((a, b) => a + b, 0);
}

async function runOneWindow(kind: string, runId: string, task: jobs.TaskForRun, windowMs: number): Promise<jobs.WindowOutcome> {
  if (kind === "same") {
    const r = await moveSameWindow({
      runId, clientTag: task.clientTag, sourceInstance: task.sourceInstance, sourceCampaignId: task.sourceCampaignId,
      sourceCampaignName: task.sourceCampaignName, b2bInstance: task.b2bInstance || "", b2cInstance: task.b2cInstance || "",
      dest: task.dest as { b2b: Record<string, number>; b2c: Record<string, number> },
      serviceAreaFilter: task.serviceAreaFilter, cursor: task.cursor, windowMs,
    });
    return {
      nextCursor: r.nextCursor, done: r.done, processed: r.processed, moved: sumVals(r.movedByKey), skippedArea: r.skippedArea, skippedLane: 0,
      skippedNoDest: r.skipped, noEmail: r.noEmail, suppressed: r.suppressed, espGuessed: r.espGuessed, movedByKey: r.movedByKey, failed: r.failed, error: r.error,
    };
  }
  const r = await moveCrossWindow({
    runId, clientTag: task.clientTag, sourceInstance: task.sourceInstance, sourceCampaignId: task.sourceCampaignId,
    sourceCampaignName: task.sourceCampaignName, targetInstance: task.targetInstance || "",
    dest: task.dest as Record<string, number>, serviceAreaFilter: task.serviceAreaFilter, cursor: task.cursor, windowMs,
  });
  return {
    nextCursor: r.nextCursor, done: r.done, processed: r.processed, moved: r.moved, skippedArea: r.skippedArea, skippedLane: r.skippedLane,
    skippedNoDest: r.skippedNoDest, noEmail: r.noEmail, suppressed: r.suppressed, espGuessed: r.espGuessed, movedByKey: r.movedByKey, failed: r.failed, error: r.error,
  };
}

const NOTHING = { processed: 0, moved: 0, skippedArea: 0, skippedLane: 0, skippedNoDest: 0, noEmail: 0, suppressed: 0, espGuessed: 0 };

async function runMoveJob(lease: jobs.Lease, deadlineMs: number): Promise<void> {
  const { id: jobId, token } = lease;
  const meta = await db.execute({ sql: "SELECT kind, run_id FROM move_job WHERE id=?", args: [jobId] });
  if (!meta.rows.length) return;
  const kind = String(meta.rows[0].kind);
  const runId = String(meta.rows[0].run_id);

  let lost = false;
  const tick = setInterval(() => {
    jobs.heartbeat(jobId, token).then((mine) => { if (!mine) lost = true; }).catch(() => {});
  }, HEARTBEAT_MS);
  try {
    while (!lost && Date.now() < deadlineMs - 2000) {
      const status = await jobs.getJobStatus(jobId);
      if (!status || ["canceled", "done", "failed"].includes(status)) break;
      const batch = await jobs.getLeasableTasks(jobId, CLIENT_CONCURRENCY);
      if (batch.length) {
        const windowMs = Math.max(8_000, Math.min(PER_WINDOW_MS, deadlineMs - Date.now() - 3000));
        await pool(batch, CLIENT_CONCURRENCY, async (task) => {
          if (lost || Date.now() >= deadlineMs - 2000) return;
          await jobs.markTaskRunning(task.id, jobId, token);
          let outcome: jobs.WindowOutcome;
          try {
            outcome = await runOneWindow(kind, runId, task, windowMs);
          } catch (e) {
            outcome = { nextCursor: task.cursor, done: false, ...NOTHING, error: (e as Error).message };
          }
          // persist-then-advance; not written = the lease moved on (or the window was already applied) → stop
          if (!(await jobs.applyTaskWindow(task, jobId, token, outcome))) lost = true;
        });
      } else {
        // Every campaign is through — send again the leads queued by "Retry errored".
        const rows = await jobs.getRetryBatch(jobId, RETRY_BATCH);
        if (!rows.length) break; // nothing left → finalize below
        const outcome = await retryFailedLeads(rows.map((r) => ({
          key: r.key, clientTag: r.clientTag, sourceInstance: r.sourceInstance, sourceCampaignId: r.sourceCampaignId, campaignId: r.campaignId, candidate: r.candidate,
        })));
        if (!(await jobs.applyRetryOutcome(jobId, token, rows, outcome))) lost = true;
      }
      await jobs.recomputeJobRollups(jobId);
      if (!lost && !(await jobs.heartbeat(jobId, token))) lost = true;
    }
  } catch (e) {
    await logError("leads-move", "run-job", (e as Error).message, { jobId }).catch(() => {});
  } finally {
    clearInterval(tick);
  }

  const finalStatus = await jobs.recomputeJobRollups(jobId);
  if (finalStatus === "running" || finalStatus === "pending") {
    if (lost) return;               // another runner holds it now — it carries on
    await jobs.releaseJob(jobId, token); // let the successor re-lease instantly
    triggerRunner(jobId);           // continue THIS job back-to-back
  } else {
    triggerRunner();                // done/failed/canceled → pick up the next pending job (serial)
  }
}

/** Lease and run one job (or the specified one) until `deadlineMs`. */
export async function runLeasable(deadlineMs: number, jobId?: string): Promise<{ ranJob: string | null }> {
  const lease = await jobs.leaseJob(LEASE_STALE_MS, jobId);
  if (!lease) return { ranJob: null };
  await runMoveJob(lease, deadlineMs);
  return { ranJob: lease.id };
}
