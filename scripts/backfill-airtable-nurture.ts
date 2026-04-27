/**
 * Backfill Airtable Master Inbox → nurture_legacy_leads.
 *
 * Usage:
 *   npx tsx scripts/backfill-airtable-nurture.ts                    # uses defaults
 *   npx tsx scripts/backfill-airtable-nurture.ts <baseId> <tableId>
 *
 * Defaults:
 *   baseId  = appqZiSdsbeBCuHEp  (Section 1)
 *   tableId = tbl1BnpnsUBrBGeuy  (Master Inbox)
 *
 * Idempotent — safe to re-run. Only touches Airtable-derived columns.
 * Run the SQL in lib/airtable/backfill-nurture.ts header before this.
 *
 * Requires AIRTABLE_PAT, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * (whichever your supabase client uses) in .env.local.
 */

import { config } from "dotenv";
import {
  backfillTable,
  DEFAULT_BASE_ID,
  DEFAULT_TABLE_ID,
} from "../lib/airtable/backfill-nurture";

config({ path: ".env.local" });

async function main() {
  const baseId = process.argv[2] || DEFAULT_BASE_ID;
  const tableId = process.argv[3] || DEFAULT_TABLE_ID;

  if (!process.env.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env.local");
    process.exit(1);
  }

  console.log(`\nBackfilling Airtable → nurture_legacy_leads`);
  console.log(`  baseId  = ${baseId}`);
  console.log(`  tableId = ${tableId}\n`);

  const t0 = Date.now();
  const result = await backfillTable(baseId, tableId, (line) => console.log(`  ${line}`));
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Done in ${seconds}s`);
  console.log(`  Pages scanned:        ${result.pagesScanned}`);
  console.log(`  Records scanned:      ${result.recordsScanned}`);
  console.log(`  Upserted:             ${result.inserted}`);
  console.log(`  Skipped (no reply):   ${result.skippedNoReply}`);
  console.log(`  Skipped (no email):   ${result.skippedNoEmail}`);
  if (result.errors > 0) console.log(`  Upsert errors:        ${result.errors}`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
