/**
 * Backfill the `esp` column on every row in:
 *   - replies                  (lead_email)
 *   - nurture_legacy_leads     (lead_email)
 *   - nurture_sequence_finished (email)
 *
 * Per-email lookups via EmailGuard (one call per unique address). The
 * SAME email appearing across multiple tables / multiple rows is only
 * looked up ONCE thanks to the in-memory cache, but no domain-level
 * shortcut — every distinct address pays its own API call.
 *
 * Usage:
 *   npx tsx scripts/backfill-esp.ts                 # all 3 tables
 *   npx tsx scripts/backfill-esp.ts replies         # one table only
 *   npx tsx scripts/backfill-esp.ts --dry           # show counts, no writes
 *   npx tsx scripts/backfill-esp.ts --concurrency 16
 *
 * Idempotent — re-runs only touch rows whose esp is still NULL.
 * Requires EMAILGUARD_API_KEY in .env.local.
 */

import { config } from "dotenv";
import supabase from "../lib/supabase";
import { lookupEmailHost } from "../lib/email-guard";

config({ path: ".env.local" });

const PAGE_SIZE = 1000;

interface TableSpec {
  name: string;
  emailColumn: string;
}

const TABLES: TableSpec[] = [
  { name: "replies", emailColumn: "lead_email" },
  { name: "nurture_legacy_leads", emailColumn: "lead_email" },
  { name: "nurture_sequence_finished", emailColumn: "email" },
];

async function fetchAllUnsetEmails(table: string, emailCol: string): Promise<string[]> {
  const all: string[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(emailCol)
      .is("esp", null)
      .not(emailCol, "is", null)
      .neq(emailCol, "")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table} select failed: ${error.message}`);
    const rows = (data || []) as unknown as Record<string, string>[];
    if (rows.length === 0) break;
    for (const r of rows) {
      const e = r[emailCol]?.trim();
      if (e) all.push(e);
    }
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T, i: number) => Promise<void>,
  concurrency: number
): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx], idx); }
      catch (e) { console.error("[backfill-esp] worker error", e); }
    }
  });
  await Promise.all(runners);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry");
  const concIdx = args.indexOf("--concurrency");
  const concurrency = concIdx >= 0 ? Math.max(1, Math.min(50, Number(args[concIdx + 1]))) : 10;
  const tableArg = args.find((a) => !a.startsWith("--") && isNaN(Number(a)));
  const tables = tableArg ? TABLES.filter((t) => t.name === tableArg) : TABLES;

  if (!process.env.EMAILGUARD_API_KEY) {
    console.error("EMAILGUARD_API_KEY is not set in .env.local");
    process.exit(1);
  }
  if (tables.length === 0) {
    console.error(`Unknown table: ${tableArg}. Choose from ${TABLES.map((t) => t.name).join(", ")}`);
    process.exit(1);
  }

  console.log(`\nBackfilling esp for ${tables.length} table${tables.length === 1 ? "" : "s"}${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`Concurrency: ${concurrency}\n`);

  // 1. Build the union of unique emails across all selected tables.
  const emailsByTable = new Map<string, Set<string>>();
  const allEmails = new Set<string>();
  for (const t of tables) {
    console.log(`Scanning ${t.name}…`);
    const emails = await fetchAllUnsetEmails(t.name, t.emailColumn);
    const unique = new Set<string>();
    for (const e of emails) {
      const lower = e.toLowerCase();
      unique.add(lower);
      allEmails.add(lower);
    }
    emailsByTable.set(t.name, unique);
    console.log(`  ${emails.length.toLocaleString()} rows missing esp → ${unique.size.toLocaleString()} unique emails`);
  }

  console.log(`\nTotal unique emails across all tables: ${allEmails.size.toLocaleString()}`);
  if (dryRun) {
    const sample = Array.from(allEmails).slice(0, 20);
    console.log("\nSample emails:");
    for (const e of sample) console.log(`  ${e}`);
    return;
  }

  // 2. Look up each unique email ONCE via EmailGuard, cache the result.
  const cache = new Map<string, string | null>();
  const emailList = Array.from(allEmails);
  let lookedUp = 0;
  let nullCount = 0;
  const t0 = Date.now();

  await runWithConcurrency(
    emailList,
    async (email) => {
      const host = await lookupEmailHost(email);
      cache.set(email, host);
      if (!host) nullCount++;
      lookedUp++;
      if (lookedUp % 100 === 0) {
        const rate = lookedUp / ((Date.now() - t0) / 1000);
        const eta = Math.round((emailList.length - lookedUp) / rate);
        const etaText = eta < 90 ? `${eta}s` : eta < 3600 ? `${Math.round(eta / 60)}m` : `${(eta / 3600).toFixed(1)}h`;
        console.log(`  Looked up ${lookedUp.toLocaleString()} / ${emailList.length.toLocaleString()} (${rate.toFixed(1)}/s, ETA ${etaText})`);
      }
    },
    concurrency
  );

  console.log(`\nLookups complete: ${lookedUp.toLocaleString()} (${nullCount.toLocaleString()} unknown / failed)`);

  // 3. For each (table, email) pair, write the cached value back.
  for (const t of tables) {
    const emails = emailsByTable.get(t.name)!;
    console.log(`\nUpdating ${t.name}…`);
    let updated = 0;
    let updateErrors = 0;
    let skipped = 0;
    let processed = 0;

    await runWithConcurrency(
      Array.from(emails),
      async (email) => {
        const host = cache.get(email);
        // Mark unknown/failed lookups as "Unknown" so the next run skips
        // them (esp is no longer NULL). Avoids burning credits on dead
        // domains every time the script runs.
        const value = host || "Unknown";
        const { error, count } = await supabase
          .from(t.name)
          .update({ esp: value }, { count: "exact" })
          .ilike(t.emailColumn, email)
          .is("esp", null);
        processed++;
        if (error) {
          updateErrors++;
          if (updateErrors <= 5) console.error(`  ${email} → update error: ${error.message}`);
          return;
        }
        if ((count || 0) === 0) skipped++;
        else updated += count || 0;
        if (processed % 500 === 0) {
          console.log(`  Updated ${updated.toLocaleString()} / processed ${processed.toLocaleString()} unique emails`);
        }
      },
      concurrency
    );

    console.log(`  ${t.name}: ${updated.toLocaleString()} rows updated, ${skipped} no-op, ${updateErrors} errors`);
  }

  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${seconds}s.`);
}

main().catch((err) => {
  console.error("backfill-esp failed:", err);
  process.exit(1);
});
