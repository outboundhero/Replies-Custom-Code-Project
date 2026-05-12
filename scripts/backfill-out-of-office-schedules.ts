/**
 * Backfill auto-reply schedules for every reply already marked
 * "Out Of Office" in the inbox.
 *
 * For each row with lead_category='Out Of Office' that hasn't been
 * scheduled yet, runs the same GPT extractor as the live mutate route
 * (lib/processing/extract-return-date.ts) and stamps:
 *   auto_reply_kind   = 'out_of_office'
 *   auto_reply_due_at = 09:00 PT on the extracted return date,
 *                       OR now+5–10min if that date is already in the past
 *                       (the lead is already back — fire ASAP).
 *
 * Skips rows where:
 *   - auto_reply_due_at is already set (already scheduled)
 *   - auto_reply_sent_at is already set (already sent)
 *   - reply_we_got is empty (nothing to extract from)
 *   - the AI can't pin a date (vague reply)
 *
 * Default = dry-run. Pass --commit to apply.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/backfill-out-of-office-schedules.ts
 *   npx tsx --env-file=.env.local scripts/backfill-out-of-office-schedules.ts --commit
 *   npx tsx --env-file=.env.local scripts/backfill-out-of-office-schedules.ts --commit --concurrency 10
 *
 * Idempotent — re-runs skip rows that have already been scheduled.
 */

import { config } from "dotenv";
import supabase from "../lib/supabase";
import { extractReturnDate } from "../lib/processing/extract-return-date";

config({ path: ".env.local" });

const PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 8;
const commit = process.argv.includes("--commit");
const concIdx = process.argv.indexOf("--concurrency");
const concurrency = concIdx >= 0
  ? Math.max(1, Math.min(30, Number(process.argv[concIdx + 1])))
  : DEFAULT_CONCURRENCY;

interface Row {
  id: number;
  lead_email: string | null;
  reply_we_got: string | null;
}

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
      catch (e) { console.error("[backfill-ooo] worker error", e); }
    }
  });
  await Promise.all(runners);
}

/**
 * Compute the auto_reply_due_at timestamp for a given return-date string.
 *   - Past or today (already 09:00+ PT) → now + 5–10 min (random)
 *   - Future → 09:00 PT on that date (= 16:00 UTC during PDT)
 */
function dueAtForReturnDate(returnDate: string): string {
  const target = new Date(`${returnDate}T16:00:00Z`); // 09:00 PDT
  const now = Date.now();
  if (target.getTime() <= now) {
    const delayMs = (5 + Math.random() * 5) * 60 * 1000;
    return new Date(now + delayMs).toISOString();
  }
  return target.toISOString();
}

async function main() {
  console.log(`\nBackfill Out-Of-Office auto-reply schedules${commit ? " (COMMIT)" : " (DRY RUN — pass --commit to apply)"}`);
  console.log(`  concurrency: ${concurrency}\n`);

  // Cursor-paginate through all OOO rows that haven't been scheduled yet.
  let lastId = 0;
  const allRows: Row[] = [];
  while (true) {
    const { data, error } = await supabase
      .from("replies")
      .select("id, lead_email, reply_we_got")
      .eq("lead_category", "Out Of Office")
      .is("auto_reply_due_at", null)
      .is("auto_reply_sent_at", null)
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (error) throw new Error(`select failed: ${error.message}`);
    const rows = (data || []) as unknown as Row[];
    if (rows.length === 0) break;
    allRows.push(...rows);
    lastId = rows[rows.length - 1].id;
    if (rows.length < PAGE_SIZE) break;
  }

  console.log(`Found ${allRows.length.toLocaleString()} Out Of Office rows pending schedule\n`);
  if (allRows.length === 0) return;

  let scheduled = 0;
  let pastDateFireSoon = 0;
  let skippedNoDate = 0;
  let skippedNoBody = 0;
  let failed = 0;

  const t0 = Date.now();

  await runWithConcurrency(
    allRows,
    async (row) => {
      const body = (row.reply_we_got || "").trim();
      if (!body) {
        skippedNoBody++;
        return;
      }

      let returnDate: string | null = null;
      try {
        returnDate = await extractReturnDate(body);
      } catch (e) {
        failed++;
        console.error(`  [${row.id}] extract failed: ${(e as Error).message}`);
        return;
      }

      if (!returnDate) {
        skippedNoDate++;
        return;
      }

      const dueAt = dueAtForReturnDate(returnDate);
      // Was it pushed to "fire soon" because the stated date is past?
      if (new Date(dueAt).getTime() < new Date(`${returnDate}T16:00:00Z`).getTime()) {
        pastDateFireSoon++;
      }

      if (!commit) {
        scheduled++;
        return;
      }

      const { error } = await supabase
        .from("replies")
        .update({
          auto_reply_due_at: dueAt,
          auto_reply_kind: "out_of_office",
          auto_reply_sent_at: null,
        })
        .eq("id", row.id);
      if (error) {
        failed++;
        console.error(`  [${row.id}] update failed: ${error.message}`);
        return;
      }
      scheduled++;

      const total = scheduled + skippedNoDate + skippedNoBody + failed;
      if (total % 50 === 0) {
        const rate = total / ((Date.now() - t0) / 1000);
        const eta = Math.round((allRows.length - total) / rate);
        const etaText = eta < 90 ? `${eta}s` : `${Math.round(eta / 60)}m`;
        console.log(`  …progress: ${scheduled.toLocaleString()} scheduled, ${skippedNoDate.toLocaleString()} no-date, ${failed.toLocaleString()} failed (${rate.toFixed(1)}/s, ETA ${etaText})`);
      }
    },
    concurrency,
  );

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`Done in ${elapsed}s`);
  console.log(`  Total OOO rows:                       ${allRows.length.toLocaleString()}`);
  console.log(`  Scheduled:                            ${scheduled.toLocaleString()}`);
  console.log(`    └─ on lead's stated return date:    ${(scheduled - pastDateFireSoon).toLocaleString()}`);
  console.log(`    └─ stated date passed → firing soon:${pastDateFireSoon.toLocaleString()}`);
  console.log(`  Skipped (no return date in reply):    ${skippedNoDate.toLocaleString()}`);
  console.log(`  Skipped (empty reply body):           ${skippedNoBody.toLocaleString()}`);
  console.log(`  Failed:                               ${failed.toLocaleString()}`);
  if (!commit) console.log(`\n(dry run — re-run with --commit to apply)`);
}

main().catch((e) => {
  console.error("backfill-out-of-office-schedules failed:", e);
  process.exit(1);
});
