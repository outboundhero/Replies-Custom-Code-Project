/**
 * Delete `replies` rows whose created_at is BEFORE May 5, 2026 12:00 PT
 * (= 2026-05-05T19:00:00Z, since PDT is UTC-7).
 *
 * Default = dry-run. Pass --commit to actually delete.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/delete-old-inbox-replies.ts
 *   npx tsx --env-file=.env.local scripts/delete-old-inbox-replies.ts --commit
 */

import { config } from "dotenv";
import supabase from "../lib/supabase";

config({ path: ".env.local" });

const CUTOFF_ISO = "2026-05-05T19:00:00Z";
const PAGE = 1000;
const commit = process.argv.includes("--commit");

async function main() {
  console.log(`\nDelete replies with created_at < ${CUTOFF_ISO}${commit ? " (COMMIT)" : " (DRY RUN — pass --commit to apply)"}`);

  const { count, error: countErr } = await supabase
    .from("replies")
    .select("id", { count: "exact", head: true })
    .lt("created_at", CUTOFF_ISO);
  if (countErr) throw new Error(`count failed: ${countErr.message}`);
  console.log(`Matching rows: ${count?.toLocaleString() ?? "?"}\n`);
  if (!count) return;

  const sample = await supabase
    .from("replies")
    .select("id, lead_email, created_at")
    .lt("created_at", CUTOFF_ISO)
    .order("created_at", { ascending: false })
    .limit(5);
  console.log("Sample (5 most recent that match):");
  for (const r of sample.data || []) console.log(`  [${r.id}] ${r.created_at}  ${r.lead_email}`);
  console.log("");

  if (!commit) {
    console.log("DRY RUN — no rows deleted. Re-run with --commit.");
    return;
  }

  // Cursor-paginate IDs (avoiding OFFSET on large tables) and delete in
  // chunks to keep statement timeout safe.
  let lastId = 0;
  let totalDeleted = 0;
  while (true) {
    const { data: ids, error } = await supabase
      .from("replies")
      .select("id")
      .lt("created_at", CUTOFF_ISO)
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (error) throw new Error(`select failed: ${error.message}`);
    if (!ids || ids.length === 0) break;

    const idList = ids.map((r) => r.id as number);
    const { error: delErr, count: delCount } = await supabase
      .from("replies")
      .delete({ count: "exact" })
      .in("id", idList);
    if (delErr) throw new Error(`delete failed: ${delErr.message}`);
    totalDeleted += delCount ?? idList.length;
    lastId = idList[idList.length - 1];
    console.log(`  deleted ${totalDeleted.toLocaleString()} so far (last id ${lastId})`);
    if (idList.length < PAGE) break;
  }
  console.log(`\nDone. Deleted ${totalDeleted.toLocaleString()} rows.`);
}

main().catch((e) => {
  console.error("delete-old-inbox-replies failed:", e);
  process.exit(1);
});
