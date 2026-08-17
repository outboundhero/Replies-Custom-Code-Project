/**
 * Lead Mover — server-side job runner. Leases a job (single-runner lease),
 * advances its tasks one small window at a time (concurrency mirrors the old
 * browser client pool), persisting cursor + counts after EVERY window so an
 * interrupted invocation resumes from the saved cursor (never restarts). Bounded
 * by `deadlineMs` (< 300s); when the budget runs out with work remaining it
 * releases its lease and self-triggers the cron so the job keeps moving back-to-
 * back. A scheduled cron is the durable backstop that resumes any stalled job.
 */
import db from "@/lib/db";
import { logError } from "@/lib/errors";
import { moveCrossWindow, moveSameWindow } from "@/lib/leads/move-window";
import * as jobs from "@/lib/leads/move-jobs";

const CLIENT_CONCURRENCY = 6;   // tasks processed at once — mirrors the old client pool
const PER_WINDOW_MS = 45_000;   // per-task window budget; small so tasks cycle + heartbeat often
export const LEASE_STALE_MS = 90_000; // a running job with no heartbeat for this long is resumable

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
    return { nextCursor: r.nextCursor, done: r.done, moved: sumVals(r.movedByKey), skippedArea: r.skippedArea, skippedLane: 0, skippedNoDest: r.skipped, movedByKey: r.movedByKey, error: r.error };
  }
  const r = await moveCrossWindow({
    runId, clientTag: task.clientTag, sourceInstance: task.sourceInstance, sourceCampaignId: task.sourceCampaignId,
    sourceCampaignName: task.sourceCampaignName, targetInstance: task.targetInstance || "",
    dest: task.dest as Record<string, number>, serviceAreaFilter: task.serviceAreaFilter, cursor: task.cursor, windowMs,
  });
  return { nextCursor: r.nextCursor, done: r.done, moved: r.moved, skippedArea: r.skippedArea, skippedLane: r.skippedLane, skippedNoDest: r.skippedNoDest, error: r.error };
}

async function runMoveJob(jobId: string, deadlineMs: number): Promise<void> {
  const meta = await db.execute({ sql: "SELECT kind, run_id FROM move_job WHERE id=?", args: [jobId] });
  if (!meta.rows.length) return;
  const kind = String(meta.rows[0].kind);
  const runId = String(meta.rows[0].run_id);

  try {
    while (Date.now() < deadlineMs - 2000) {
      const status = await jobs.getJobStatus(jobId);
      if (!status || ["canceled", "done", "failed"].includes(status)) break;
      const batch = await jobs.getLeasableTasks(jobId, CLIENT_CONCURRENCY);
      if (!batch.length) break; // no not-done tasks left → finalize below
      const windowMs = Math.max(8_000, Math.min(PER_WINDOW_MS, deadlineMs - Date.now() - 3000));
      await pool(batch, CLIENT_CONCURRENCY, async (task) => {
        if (Date.now() >= deadlineMs - 2000) return;
        await jobs.markTaskRunning(task.id);
        try {
          const outcome = await runOneWindow(kind, runId, task, windowMs);
          await jobs.applyTaskWindow(task.id, outcome); // persist-then-advance
        } catch (e) {
          await jobs.applyTaskWindow(task.id, { nextCursor: task.cursor, done: false, moved: 0, skippedArea: 0, skippedLane: 0, skippedNoDest: 0, error: (e as Error).message });
        }
      });
      await jobs.recomputeJobRollups(jobId);
      await jobs.heartbeat(jobId);
    }
  } catch (e) {
    await logError("leads-move", "run-job", (e as Error).message, { jobId }).catch(() => {});
  }

  const finalStatus = await jobs.recomputeJobRollups(jobId);
  if (finalStatus === "running" || finalStatus === "pending") {
    await jobs.releaseJob(jobId); // let the successor re-lease instantly
    triggerRunner(jobId);         // continue THIS job back-to-back
  } else {
    triggerRunner();              // done/failed/canceled → pick up the next pending job (serial)
  }
}

/** Lease and run one job (or the specified one) until `deadlineMs`. */
export async function runLeasable(deadlineMs: number, jobId?: string): Promise<{ ranJob: string | null }> {
  const leased = await jobs.leaseJob(LEASE_STALE_MS, jobId);
  if (!leased) return { ranJob: null };
  await runMoveJob(leased, deadlineMs);
  return { ranJob: leased };
}
