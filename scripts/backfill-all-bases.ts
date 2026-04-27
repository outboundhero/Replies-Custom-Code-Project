/**
 * Backfill the Master Inbox table from EVERY Section base into
 * nurture_legacy_leads.
 *
 * Iterates through all 7 bases (Section 1–7) sequentially. For each base,
 * looks up the Master Inbox table id by name (so it works even if a base
 * was created from a slightly different template) and runs the same
 * backfillTable helper used by the per-base script.
 *
 * Idempotent — safe to re-run. Lifecycle columns are preserved.
 *
 *   npx tsx scripts/backfill-all-bases.ts
 */

import { config } from "dotenv";
import {
  ALL_BASES,
  backfillTable,
  findMasterInboxTableId,
  type BackfillResult,
} from "../lib/airtable/backfill-nurture";

config({ path: ".env.local" });

async function main() {
  if (!process.env.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env.local");
    process.exit(1);
  }

  console.log(`\nBackfilling Airtable → nurture_legacy_leads for ${ALL_BASES.length} bases\n`);

  const t0 = Date.now();
  const results: BackfillResult[] = [];
  const failures: { base: string; baseId: string; error: string }[] = [];

  for (const { name, baseId } of ALL_BASES) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`${name}  (${baseId})`);
    console.log(`${"═".repeat(60)}`);
    try {
      const tableId = await findMasterInboxTableId(baseId);
      console.log(`  Master Inbox table: ${tableId}`);
      const result = await backfillTable(baseId, tableId, (line) => console.log(`  ${line}`));
      results.push(result);
      console.log(
        `  → ${result.inserted} upserted | ${result.skippedNoReply} no-reply | ${result.skippedBadClientTag} bad-tag | ${result.skippedNoEmail} no-email | ${result.errors} errors`
      );
    } catch (err) {
      const msg = (err as Error).message;
      failures.push({ base: name, baseId, error: msg });
      console.log(`  ✗ FAILED: ${msg}`);
    }
  }

  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  const totals = results.reduce(
    (acc, r) => {
      acc.inserted += r.inserted;
      acc.scanned += r.recordsScanned;
      acc.noReply += r.skippedNoReply;
      acc.noEmail += r.skippedNoEmail;
      acc.badTag += r.skippedBadClientTag;
      acc.errors += r.errors;
      return acc;
    },
    { inserted: 0, scanned: 0, noReply: 0, noEmail: 0, badTag: 0, errors: 0 }
  );

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Done in ${seconds}s — ${results.length}/${ALL_BASES.length} bases succeeded`);
  console.log(`  Total scanned:        ${totals.scanned}`);
  console.log(`  Total upserted:       ${totals.inserted}`);
  console.log(`  Skipped (no reply):   ${totals.noReply}`);
  console.log(`  Skipped (bad client): ${totals.badTag}`);
  console.log(`  Skipped (no email):   ${totals.noEmail}`);
  console.log(`  Upsert errors:        ${totals.errors}`);

  if (failures.length > 0) {
    console.log(`\n${failures.length} base${failures.length === 1 ? "" : "s"} failed:`);
    for (const f of failures) console.log(`  • ${f.base} (${f.baseId}) — ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
