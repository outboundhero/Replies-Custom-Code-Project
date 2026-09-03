/**
 * Dry-run the stopped-lead recovery across ALL eligible clients using the REAL
 * recovery function (dry mode = no Bison writes, no ledger writes). Archived-
 * inclusive scope. Streams a line per client; prints a sorted table + totals.
 *
 *   npx tsx -r dotenv/config scripts/recover-stopped-dryrun.ts dotenv_config_path=.env.local
 */
import { recoverStoppedForClient, listEligibleClients, BACKFILL_STATUSES, type RecoverResult } from "@/lib/nurture/recover-stopped";

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function main() {
  const tags = await listEligibleClients();
  const rows: RecoverResult[] = [];
  let done = 0;
  await pool(tags, 2, async (tag) => {
    let r: RecoverResult;
    try { r = await recoverStoppedForClient(tag, { dry: true, statuses: BACKFILL_STATUSES }); }
    catch (e) { console.log(`...ERR ${tag}: ${(e as Error).message}`); done++; return; }
    rows.push(r);
    done++;
    console.log(`...${done}/${tags.length} ${tag}: eligible=${r.eligible} unique=${r.uniqueStopped} (bl=${r.excludedBlacklisted} bnc=${r.excludedBounced} alreadyRec=${r.excludedAlreadyRecovered} smr=${r.excludedSheetMeetingReady})${r.noMap ? " NO-MAP" : ""}${r.error ? " ERR:" + r.error : ""}`);
  });

  rows.sort((a, b) => b.eligible - a.eligible);
  console.log("\n=== STOPPED-LEAD RECOVERY DRY-RUN (real code, archived-inclusive) ===");
  console.log(`${"TAG".padEnd(10)} ${"ELIGIBLE".padStart(9)} ${"UNIQUE".padStart(8)} ${"BLACK".padStart(7)} ${"BOUNCE".padStart(7)} ${"SMR".padStart(6)}  FLAGS`);
  let e = 0, u = 0, bl = 0, bo = 0, smr = 0;
  const noMap: string[] = [];
  for (const r of rows) {
    const flags = [r.noMap ? "NO-MAP" : "", r.error ? "ERR" : ""].filter(Boolean).join(" ");
    console.log(`${r.clientTag.padEnd(10)} ${String(r.eligible).padStart(9)} ${String(r.uniqueStopped).padStart(8)} ${String(r.excludedBlacklisted).padStart(7)} ${String(r.excludedBounced).padStart(7)} ${String(r.excludedSheetMeetingReady).padStart(6)}  ${flags}`);
    e += r.eligible; u += r.uniqueStopped; bl += r.excludedBlacklisted; bo += r.excludedBounced; smr += r.excludedSheetMeetingReady;
    if (r.noMap && r.uniqueStopped > 0) noMap.push(r.clientTag);
  }
  console.log(`\nGRAND TOTAL — WOULD RE-ADD (eligible net): ${e}`);
  console.log(`  unique stopped=${u}  excluded: blacklisted=${bl} bounced=${bo} sheet-meeting-ready=${smr}`);
  console.log(`clients with stopped leads but NO nurture map (can't recover until mapped): ${noMap.length ? noMap.join(", ") : "none"}`);
  console.log("=== DONE ===");
}
main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
