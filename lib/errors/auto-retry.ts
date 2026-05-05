/**
 * Shared retry logic for airtable-stage errors.
 *
 * Used by:
 *   - scripts/retry-airtable-errors.ts  (one-shot, no time bound)
 *   - app/api/cron/retry-airtable-errors/route.ts  (every 2h, deadline-bounded)
 *
 * For each airtable-stage error in the log:
 *   1. Resolve the original webhook payload — either from the error row's
 *      own _webhook_payload field (new code path) or by finding the
 *      nearest webhook-stage sibling within ±5 minutes whose payload's
 *      lead email matches.
 *   2. Replay the processing function (tracked or untracked).
 *   3. On success: delete the airtable row AND its webhook sibling so
 *      neither lingers as page noise.
 *
 * Honors a deadline + max-item budget so the cron caller can ensure it
 * returns before Vercel's maxDuration.
 */

import db from "@/lib/db";
import { processTrackedReply } from "@/lib/processing/tracked";
import { processUntrackedReply } from "@/lib/processing/untracked";

interface ErrorRow {
  id: number;
  workflow: string;
  stage: string;
  timestamp: string;
  message: string;
  payload: string | null;
}

interface AirtableErrPayload {
  _webhook_payload?: unknown;
  lead_email?: string;
}

interface WebhookEnvelope {
  _webhook_payload?: {
    data?: {
      lead?: { email?: string };
      reply?: { from_email_address?: string };
    };
  };
}

export interface RetryBatchOptions {
  /** Max items to process this batch. Default: unlimited (script use). */
  maxItems?: number;
  /** Hard deadline (Date.now() + ms). Stops mid-loop when reached. Default: no deadline. */
  deadlineMs?: number;
  /** Concurrency. Default 5 (cron) — script bumps to 8. */
  concurrency?: number;
  /** Workflow filter ("tracked" | "untracked" | undefined for both). */
  workflow?: string;
  /** Optional progress callback. */
  onProgress?: (counts: { processed: number; succeeded: number; failed: number; unrecoverable: number }) => void;
}

export interface RetryBatchResult {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  unrecoverable: number;
  hitDeadline: boolean;
  hitItemCap: boolean;
  elapsedMs: number;
}

async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
  shouldStop?: () => boolean,
): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      if (shouldStop?.()) return;
      const idx = i++;
      try { await worker(items[idx]); }
      catch (e) { console.error("[auto-retry] worker error", e); }
    }
  });
  await Promise.all(runners);
}

async function resolveWebhookPayload(err: ErrorRow): Promise<unknown | null> {
  let context: AirtableErrPayload = {};
  if (err.payload) {
    try {
      context = JSON.parse(err.payload) as AirtableErrPayload;
      if (context._webhook_payload) return context._webhook_payload;
    } catch { /* swallow */ }
  }

  const targetEmail = (context.lead_email || "").toLowerCase();

  const siblings = await db.execute({
    sql: `SELECT payload FROM error_log
          WHERE workflow = ? AND stage = 'webhook' AND payload IS NOT NULL
          AND timestamp >= datetime(?, '-5 minutes') AND timestamp <= datetime(?, '+5 minutes')
          ORDER BY ABS(strftime('%s', timestamp) - strftime('%s', ?)) ASC`,
    args: [err.workflow, err.timestamp, err.timestamp, err.timestamp],
  });

  if (siblings.rows.length === 0) return null;

  let bestPayload: unknown | null = null;
  for (const row of siblings.rows) {
    try {
      const parsed = JSON.parse(row.payload as string) as WebhookEnvelope;
      const wp = parsed?._webhook_payload;
      if (!wp) continue;
      if (!bestPayload) bestPayload = wp;
      const email = (
        wp.data?.lead?.email
        || wp.data?.reply?.from_email_address
        || ""
      ).toLowerCase();
      if (targetEmail && email === targetEmail) return wp;
    } catch { /* swallow */ }
  }
  return bestPayload;
}

export async function retryAirtableErrorsBatch(opts: RetryBatchOptions = {}): Promise<RetryBatchResult> {
  const concurrency = opts.concurrency ?? 5;
  const t0 = Date.now();

  const where: string[] = ["stage = 'airtable'"];
  const args: string[] = [];
  if (opts.workflow) { where.push("workflow = ?"); args.push(opts.workflow); }

  // Cap the initial query so we don't pull a million rows into memory.
  const queryLimit = opts.maxItems ?? 5000;
  const result = await db.execute({
    sql: `SELECT id, workflow, stage, timestamp, message, payload
          FROM error_log
          WHERE ${where.join(" AND ")}
          ORDER BY id ASC
          LIMIT ?`,
    args: [...args, queryLimit],
  });

  const errors = result.rows as unknown as ErrorRow[];
  let succeeded = 0;
  let failed = 0;
  let unrecoverable = 0;
  let processed = 0;
  let hitDeadline = false;

  const shouldStop = () => {
    if (opts.deadlineMs && Date.now() >= opts.deadlineMs) {
      hitDeadline = true;
      return true;
    }
    return false;
  };

  await runWithConcurrency(
    errors,
    async (err) => {
      processed++;
      const payload = await resolveWebhookPayload(err);
      if (!payload) {
        unrecoverable++;
        opts.onProgress?.({ processed, succeeded, failed, unrecoverable });
        return;
      }
      try {
        if (err.workflow === "tracked") {
          await processTrackedReply(payload as Parameters<typeof processTrackedReply>[0]);
        } else if (err.workflow === "untracked") {
          await processUntrackedReply(payload as Parameters<typeof processUntrackedReply>[0]);
        } else {
          return;
        }
        // Delete the airtable row AND its webhook sibling so neither
        // lingers in the log as orphan noise.
        await db.execute({ sql: "DELETE FROM error_log WHERE id = ?", args: [err.id] });
        await db.execute({
          sql: `DELETE FROM error_log
                WHERE stage = 'webhook' AND workflow = ?
                  AND timestamp >= datetime(?, '-5 minutes')
                  AND timestamp <= datetime(?, '+5 minutes')`,
          args: [err.workflow, err.timestamp, err.timestamp],
        });
        succeeded++;
      } catch {
        failed++;
      }
      opts.onProgress?.({ processed, succeeded, failed, unrecoverable });
    },
    concurrency,
    shouldStop,
  );

  return {
    total: errors.length,
    processed,
    succeeded,
    failed,
    unrecoverable,
    hitDeadline,
    hitItemCap: opts.maxItems != null && errors.length >= opts.maxItems,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * Sweep webhook-stage rows whose airtable counterpart no longer exists.
 * Safe to call after retryAirtableErrorsBatch — pre-fix orphans get
 * cleaned up here. Always uses a 5-minute "in flight" buffer so we
 * never delete a row that another retry might still need.
 */
export async function cleanupOrphanWebhookErrors(): Promise<{ deleted: number }> {
  const orphans = await db.execute(`
    SELECT w.id FROM error_log w
    WHERE w.stage = 'webhook'
      AND w.timestamp < datetime('now', '-5 minutes')
      AND NOT EXISTS (
        SELECT 1 FROM error_log a
        WHERE a.stage = 'airtable'
          AND a.workflow = w.workflow
          AND a.timestamp >= datetime(w.timestamp, '-5 minutes')
          AND a.timestamp <= datetime(w.timestamp, '+5 minutes')
      )
  `);

  const ids = orphans.rows.map((r) => r.id as number);
  if (ids.length === 0) return { deleted: 0 };

  const CHUNK = 500;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const res = await db.execute({
      sql: `DELETE FROM error_log WHERE id IN (${placeholders})`,
      args: chunk as number[],
    });
    deleted += res.rowsAffected ?? chunk.length;
  }
  return { deleted };
}
