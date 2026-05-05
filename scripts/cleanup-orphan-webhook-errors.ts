/**
 * Delete webhook-stage error rows that have no matching airtable-stage
 * sibling in the same workflow within ±5 minutes — i.e. the webhook row
 * whose downstream failure has already been retried away by
 * scripts/retry-airtable-errors.ts.
 *
 * Background: a single failed reply produces two error_log rows:
 *   - airtable: the actual cause + retry context
 *   - webhook:  the full payload, used by the retry route to replay
 * The retry script only deletes the airtable row. The webhook row stays,
 * even though its only purpose (replaying) has been served.
 *
 * Default = dry-run. --commit to actually delete.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/cleanup-orphan-webhook-errors.ts
 *   npx tsx --env-file=.env.local scripts/cleanup-orphan-webhook-errors.ts --commit
 *
 * Idempotent — only operates on webhook-stage rows whose retry-purpose
 * sibling is gone.
 */

import { config } from "dotenv";
import db from "../lib/db";

config({ path: ".env.local" });

const commit = process.argv.includes("--commit");

async function main() {
  console.log(`\nCleanup orphan webhook-stage errors${commit ? " (COMMIT)" : " (DRY RUN — pass --commit to apply)"}`);

  // Webhook rows older than 5 minutes (give in-flight retries time) AND
  // with no airtable-stage sibling within ±5 minutes for the same workflow.
  // The 5min upper bound mirrors retry-airtable-errors.ts's sibling-lookup
  // window so we never delete a row another retry might still need.
  const orphanQuery = `
    SELECT w.id, w.workflow, w.timestamp, w.message
    FROM error_log w
    WHERE w.stage = 'webhook'
      AND w.timestamp < datetime('now', '-5 minutes')
      AND NOT EXISTS (
        SELECT 1 FROM error_log a
        WHERE a.stage = 'airtable'
          AND a.workflow = w.workflow
          AND a.timestamp >= datetime(w.timestamp, '-5 minutes')
          AND a.timestamp <= datetime(w.timestamp, '+5 minutes')
      )
  `;

  const orphans = await db.execute(orphanQuery);
  console.log(`\nOrphan webhook rows: ${orphans.rows.length}`);

  if (orphans.rows.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  const sample = orphans.rows.slice(0, 5);
  console.log(`\nSample (first 5):`);
  for (const r of sample) {
    console.log(`  [${r.id}] ${r.workflow} @ ${r.timestamp}: ${String(r.message).slice(0, 80)}`);
  }

  if (!commit) {
    console.log("\nDRY RUN — no rows deleted. Re-run with --commit to delete.");
    return;
  }

  console.log("\nDeleting…");
  // SQLite can have a parameter-count limit (default 32766 in modern
  // builds, lower on older). Chunk the IDs to be safe.
  const ids = orphans.rows.map((r) => r.id as number);
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
  console.log(`Deleted ${deleted} rows.`);
}

main().catch((e) => {
  console.error("cleanup-orphan-webhook-errors failed:", e);
  process.exit(1);
});
