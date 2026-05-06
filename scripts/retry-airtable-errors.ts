/**
 * Bulk-retry every airtable-stage error in the error log.
 *
 * Thin wrapper around lib/errors/auto-retry.ts. The same logic powers the
 * /api/cron/retry-airtable-errors job that runs every 2 hours — this
 * script is for one-off, unbounded backfills (e.g. after a major incident).
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/retry-airtable-errors.ts
 *   npx tsx --env-file=.env.local scripts/retry-airtable-errors.ts --workflow tracked
 *   npx tsx --env-file=.env.local scripts/retry-airtable-errors.ts --concurrency 10
 *
 * Idempotent — only operates on stage='airtable' rows; deletes them and
 * their webhook sibling on successful retry.
 */

import { config } from "dotenv";
import { retryAirtableErrorsBatch, cleanupOrphanWebhookErrors, cleanupUnrecoverableAirtableErrors } from "../lib/errors/auto-retry";

config({ path: ".env.local" });

function parseArg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

const workflowFilter = parseArg("workflow") ?? undefined;
const concurrencyStr = parseArg("concurrency");
const concurrency = concurrencyStr ? Math.max(1, Math.min(20, Number(concurrencyStr))) : 8;

async function main() {
  console.log(`\nBulk retry of airtable-stage errors`);
  console.log(`  workflow filter: ${workflowFilter || "(both)"}`);
  console.log(`  concurrency:     ${concurrency}\n`);

  let lastLog = Date.now();
  const t0 = Date.now();

  const result = await retryAirtableErrorsBatch({
    concurrency,
    workflow: workflowFilter,
    onProgress: (counts) => {
      // Log every 10 items, but throttle to once per 2s minimum.
      if (counts.processed % 10 !== 0) return;
      if (Date.now() - lastLog < 2000) return;
      lastLog = Date.now();
      const rate = counts.processed / ((Date.now() - t0) / 1000);
      console.log(`  …progress: ${counts.succeeded.toLocaleString()} ok, ${counts.failed.toLocaleString()} failed, ${counts.unrecoverable.toLocaleString()} unrecoverable (${rate.toFixed(1)}/s)`);
    },
  });

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Retry done in ${(result.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`  Total:        ${result.total}`);
  console.log(`  Succeeded:    ${result.succeeded}`);
  console.log(`  Failed:       ${result.failed}`);
  console.log(`  Unrecoverable:${result.unrecoverable}`);

  console.log(`\nSweeping orphan webhook rows…`);
  const sweep = await cleanupOrphanWebhookErrors();
  console.log(`  Deleted ${sweep.deleted} orphan webhook rows`);

  console.log(`\nSweeping unrecoverable airtable rows (>30 min old, no payload, no sibling)…`);
  const stale = await cleanupUnrecoverableAirtableErrors();
  console.log(`  Deleted ${stale.deleted} unrecoverable airtable rows`);
}

main().catch((e) => {
  console.error("retry-airtable-errors failed:", e);
  process.exit(1);
});
