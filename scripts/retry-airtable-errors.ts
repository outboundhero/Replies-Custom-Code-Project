/**
 * Bulk-retry every airtable-stage error in the error log.
 *
 * Background: airtable failures used to log without storing the original
 * webhook payload — only context (lead_email, tag, etc.). The retry route
 * tries to recover the payload from a webhook-stage sibling row within a
 * time window, but a tight window + clearing of webhook rows leaves many
 * old errors unrecoverable from the UI.
 *
 * This script does the same recovery server-side with a wider time window
 * AND uses the stored lead_email to pick the correct sibling when several
 * webhooks land close together. Bypasses the HTTP/auth boundary by calling
 * the processing functions directly.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/retry-airtable-errors.ts --dry
 *   npx tsx --env-file=.env.local scripts/retry-airtable-errors.ts
 *   npx tsx --env-file=.env.local scripts/retry-airtable-errors.ts --workflow tracked
 *   npx tsx --env-file=.env.local scripts/retry-airtable-errors.ts --concurrency 3
 *
 * Idempotent — only operates on rows with stage='airtable' and deletes
 * each row on successful retry.
 */

import { config } from "dotenv";
import db from "../lib/db";
import { processTrackedReply } from "../lib/processing/tracked";
import { processUntrackedReply } from "../lib/processing/untracked";

config({ path: ".env.local" });

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
  tag?: string;
  section?: string;
  company_code?: string;
}

interface WebhookEnvelope {
  _webhook_payload?: {
    data?: {
      lead?: { email?: string };
      reply?: { from_email_address?: string };
    };
  };
}

function parseArg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

const dryRun = process.argv.includes("--dry");
const workflowFilter = parseArg("workflow"); // "tracked" | "untracked" | null
const concurrencyStr = parseArg("concurrency");
const concurrency = concurrencyStr ? Math.max(1, Math.min(20, Number(concurrencyStr))) : 3;

async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  conc: number,
): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx]); }
      catch (e) { console.error("[retry] worker error", e); }
    }
  });
  await Promise.all(runners);
}

/**
 * Resolve the original webhook payload for a single airtable error.
 * Strategy:
 *   1. If the error's own payload already has _webhook_payload (new code path), use it.
 *   2. Otherwise look for webhook-stage rows in the same workflow within
 *      ±5 minutes of this error and pick the one whose payload's lead email
 *      matches the airtable error's lead_email. Fall back to the closest in time.
 */
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

  // Walk siblings (already sorted nearest-first); prefer one whose
  // _webhook_payload.lead matches the target email.
  let bestPayload: unknown | null = null;
  for (const row of siblings.rows) {
    try {
      const parsed = JSON.parse(row.payload as string) as WebhookEnvelope;
      const wp = parsed?._webhook_payload;
      if (!wp) continue;
      if (!bestPayload) bestPayload = wp; // first valid = closest in time
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

async function main() {
  console.log(`\nBulk retry of airtable-stage errors${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`  workflow filter: ${workflowFilter || "(both)"}`);
  console.log(`  concurrency:     ${concurrency}`);
  console.log("");

  const where: string[] = ["stage = 'airtable'"];
  const args: string[] = [];
  if (workflowFilter) { where.push("workflow = ?"); args.push(workflowFilter); }

  const result = await db.execute({
    sql: `SELECT id, workflow, stage, timestamp, message, payload
          FROM error_log
          WHERE ${where.join(" AND ")}
          ORDER BY id ASC`,
    args,
  });

  const errors = result.rows as unknown as ErrorRow[];
  console.log(`Found ${errors.length} airtable error(s)\n`);
  if (errors.length === 0) return;

  let resolved = 0;
  let succeeded = 0;
  let failed = 0;
  let unrecoverable = 0;
  const t0 = Date.now();

  await runWithConcurrency(
    errors,
    async (err) => {
      const payload = await resolveWebhookPayload(err);
      if (!payload) {
        unrecoverable++;
        console.log(`  [${err.id}] ${err.workflow} — no recoverable webhook payload (skip)`);
        return;
      }
      resolved++;

      if (dryRun) {
        console.log(`  [${err.id}] ${err.workflow} — would retry`);
        return;
      }

      try {
        if (err.workflow === "tracked") {
          await processTrackedReply(payload as Parameters<typeof processTrackedReply>[0]);
        } else if (err.workflow === "untracked") {
          await processUntrackedReply(payload as Parameters<typeof processUntrackedReply>[0]);
        } else {
          console.log(`  [${err.id}] unknown workflow ${err.workflow} — skip`);
          return;
        }
        await db.execute({ sql: "DELETE FROM error_log WHERE id = ?", args: [err.id] });
        succeeded++;
        if ((succeeded + failed) % 10 === 0) {
          const rate = (succeeded + failed) / ((Date.now() - t0) / 1000);
          console.log(`  …progress: ${succeeded.toLocaleString()} ok, ${failed.toLocaleString()} failed, ${unrecoverable.toLocaleString()} unrecoverable (${rate.toFixed(1)}/s)`);
        }
      } catch (e) {
        failed++;
        console.log(`  [${err.id}] ${err.workflow} — retry failed: ${(e as Error).message?.slice(0, 200)}`);
      }
    },
    concurrency
  );

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`Done in ${sec}s`);
  console.log(`  Total errors:    ${errors.length}`);
  console.log(`  Resolved payload:${resolved}`);
  console.log(`  Retried OK:      ${succeeded}`);
  console.log(`  Retried + failed:${failed}`);
  console.log(`  Unrecoverable:   ${unrecoverable}`);
}

main().catch((e) => {
  console.error("retry-airtable-errors failed:", e);
  process.exit(1);
});
