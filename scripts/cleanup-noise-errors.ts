/**
 * Delete error_log rows that match the two known SMTP / sender-id noise
 * patterns the user explicitly approved for cleanup.
 *
 * 1. 400 SMTP auth failures:
 *    "Error sending email. Please re-connect this email account: Message
 *     from provider: SMTP Error: Could not authenticate."
 * 2. 422 invalid sender_email_id:
 *    "The selected sender email id is invalid."
 *
 * Default = dry-run. Pass --commit to delete.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/cleanup-noise-errors.ts
 *   npx tsx --env-file=.env.local scripts/cleanup-noise-errors.ts --commit
 */

import { config } from "dotenv";
import db from "../lib/db";

config({ path: ".env.local" });

const commit = process.argv.includes("--commit");

const PATTERNS = [
  "%SMTP Error: Could not authenticate.%",
  "%The selected sender email id is invalid.%",
];

async function main() {
  console.log(`\nDelete noise errors${commit ? " (COMMIT)" : " (DRY RUN — pass --commit to apply)"}`);
  console.log("Patterns being matched (LIKE):");
  for (const p of PATTERNS) console.log(`  · ${p}`);
  console.log("");

  let totalMatched = 0;
  let totalDeleted = 0;

  for (const pattern of PATTERNS) {
    const countRes = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM error_log WHERE message LIKE ?",
      args: [pattern],
    });
    const n = Number((countRes.rows[0] as unknown as { n: number }).n);
    totalMatched += n;
    console.log(`  ${pattern}  →  ${n.toLocaleString()} rows`);

    if (commit && n > 0) {
      const delRes = await db.execute({
        sql: "DELETE FROM error_log WHERE message LIKE ?",
        args: [pattern],
      });
      const d = delRes.rowsAffected ?? n;
      totalDeleted += d;
      console.log(`    deleted ${d.toLocaleString()}`);
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Total matching rows:  ${totalMatched.toLocaleString()}`);
  if (commit) console.log(`Total deleted:        ${totalDeleted.toLocaleString()}`);
  else        console.log(`(dry run — re-run with --commit to delete)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
