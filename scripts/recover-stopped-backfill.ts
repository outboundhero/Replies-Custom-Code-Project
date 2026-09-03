/**
 * ONE-TIME historical backfill: recover every eligible client's stopped leads
 * (archived-inclusive) into nurture. Streaming + idempotent (ledger), so it's
 * safe to stop/resume — re-running skips already-recovered leads. Long-running
 * (Bison serves ~15 leads/page); run in the background.
 *
 *   npx tsx -r dotenv/config scripts/recover-stopped-backfill.ts dotenv_config_path=.env.local
 *
 * Optionally pass a concurrency as the first arg (default 3).
 */
import { recoverStoppedForClient, listEligibleClients, BACKFILL_STATUSES, type RecoverResult } from "@/lib/nurture/recover-stopped";

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function main() {
  const conc = Math.max(1, Number(process.argv.find((a) => /^\d+$/.test(a))) || 3);
  const tags = await listEligibleClients();
  console.log(`=== STOPPED-LEAD BACKFILL (live, archived-inclusive) — ${tags.length} clients, concurrency ${conc} ===`);
  let done = 0, grandAttached = 0, grandReplied = 0, grandAlready = 0;
  const noMap: string[] = [];
  const errors: string[] = [];
  await pool(tags, conc, async (tag) => {
    const t = Date.now();
    let r: RecoverResult;
    try { r = await recoverStoppedForClient(tag, { dry: false, statuses: BACKFILL_STATUSES }); }
    catch (e) { done++; errors.push(`${tag}: ${(e as Error).message}`); console.log(`[${done}/${tags.length}] ${tag} FATAL: ${(e as Error).message}`); return; }
    done++; grandAttached += r.attached; grandReplied += r.excludedReplied; grandAlready += r.excludedAlreadyRecovered;
    if (r.noMap) noMap.push(tag);
    if (r.error) errors.push(`${tag}: ${r.error}`);
    console.log(`[${done}/${tags.length}] ${tag}: attached=${r.attached} unique=${r.uniqueStopped} eligible=${r.eligible} bnc=${r.excludedBounced} replied=${r.excludedReplied} alreadyRec=${r.excludedAlreadyRecovered} smr=${r.excludedSheetMeetingReady}${r.noMap ? " NO-MAP" : ""}${r.error ? " ERR:" + r.error : ""} (${Math.round((Date.now() - t) / 1000)}s) | GRAND attached=${grandAttached}`);
  });
  console.log(`\n=== BACKFILL COMPLETE ===`);
  console.log(`total attached (recovered into nurture): ${grandAttached}`);
  console.log(`total replied (excluded): ${grandReplied}   total already-recovered (skipped): ${grandAlready}`);
  console.log(`clients with NO nurture map (couldn't recover): ${noMap.length ? noMap.join(", ") : "none"}`);
  if (errors.length) { console.log(`errors (${errors.length}):`); errors.forEach((e) => console.log("  " + e)); }
  console.log("=== DONE ===");
}
main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
