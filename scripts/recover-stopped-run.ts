/**
 * LIVE stopped-lead recovery for a chosen set of client tags (archived-inclusive),
 * then a verify re-run of the first tag to PROVE idempotency (0 re-adds).
 *
 *   npx tsx -r dotenv/config scripts/recover-stopped-run.ts dotenv_config_path=.env.local TAG1 TAG2 ...
 * If no tags are passed, runs the default small first batch.
 */
import { recoverStoppedForClient, type RecoverResult, BACKFILL_STATUSES } from "@/lib/nurture/recover-stopped";

const DEFAULT_BATCH = ["AGCS", "CVJIND", "MGS", "DBSTX", "SI"];

function line(r: RecoverResult): string {
  return `${r.clientTag.padEnd(10)} attached=${String(r.attached).padStart(6)} eligible=${String(r.eligible).padStart(6)} unique=${String(r.uniqueStopped).padStart(6)} bnc=${r.excludedBounced} replied=${r.excludedReplied} alreadyRec=${r.excludedAlreadyRecovered} smr=${r.excludedSheetMeetingReady} unmapped=${r.unmapped}${r.budgetHit ? " BUDGET-HIT" : ""}${r.noMap ? " NO-MAP" : ""}${r.error ? " ERR:" + r.error : ""}`;
}

async function main() {
  const argTags = process.argv.slice(2).filter((a) => /^[A-Z0-9&]+$/i.test(a)).map((a) => a.toUpperCase());
  const batch = argTags.length ? argTags : DEFAULT_BATCH;
  console.log(`=== LIVE recovery batch: ${batch.join(", ")} ===`);
  const results: RecoverResult[] = [];
  for (const tag of batch) {
    const t = Date.now();
    const r = await recoverStoppedForClient(tag, { dry: false, statuses: BACKFILL_STATUSES });
    results.push(r);
    console.log(`${line(r)}  (${Math.round((Date.now() - t) / 1000)}s)`);
  }

  // VERIFY idempotency: re-run the first tag — attached must be 0, everything
  // now counted as already-recovered.
  const first = batch[0];
  console.log(`\n=== VERIFY re-run of ${first} (expect attached=0, alreadyRec≈eligible) ===`);
  const v = await recoverStoppedForClient(first, { dry: false, statuses: BACKFILL_STATUSES });
  console.log(line(v));
  console.log(v.attached === 0 ? "✅ IDEMPOTENT — no leads re-added on re-run" : `⚠️ re-run attached ${v.attached} (investigate)`);

  const totalAttached = results.reduce((n, r) => n + r.attached, 0);
  console.log(`\nBATCH TOTAL attached: ${totalAttached}`);
  console.log("=== DONE ===");
}
main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
