/**
 * Backfill the `esp` column on every row in:
 *   - replies                  (lead_email)
 *   - nurture_legacy_leads     (lead_email)
 *   - nurture_sequence_finished (email)
 *
 * Two design changes from the previous version:
 *
 * 1. INCREMENTAL WRITES — each lookup writes its result to Supabase
 *    immediately. The old design cached all 378k results in memory then
 *    flushed at the end; if the run died after lookup but before
 *    flush, all work was lost. Now if the script crashes mid-run, every
 *    completed lookup is already in the DB.
 *
 * 2. PRIORITY TIERS — the script processes leads in business-priority
 *    order so the most-actionable rows get ESP first:
 *      Tier 1: Ready-to-nurture (eligible + safe + not added/skipped)
 *      Tier 2: All eligible (past 45-day cooldown, any safety)
 *      Tier 3: Waiting (within 45-day cooldown)
 *    The Nurture page becomes ESP-aware for Ready-to-nurture leads
 *    within minutes, even though the full backfill still takes hours.
 *
 * Per-email cache (in-memory) means the same address appearing across
 * multiple tiers / multiple tables only costs one EmailGuard call.
 *
 * Usage:
 *   npx tsx scripts/backfill-esp.ts                     # all 3 tiers
 *   npx tsx scripts/backfill-esp.ts --tier 1            # only Ready
 *   npx tsx scripts/backfill-esp.ts --concurrency 5
 *   npx tsx scripts/backfill-esp.ts --reset-unknowns    # clear bad data
 *
 * Idempotent — re-runs skip rows whose esp is already set.
 * Requires EMAILGUARD_API_KEY in .env.local.
 */

import { config } from "dotenv";
import supabase from "../lib/supabase";
import { lookupEmailHost } from "../lib/email-guard";

config({ path: ".env.local" });

const PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 5;
const NURTURE_DAYS = 45;

// ── Mirror of EXCLUDED_AI_CATEGORIES in /api/nurture/route.ts ──
const EXCLUDED_AI_CATEGORIES = [
  "Interested", "Meeting Request", "Meeting Set",
  "Do Not Contact", "Wrong Person", "Wrong Person (Change of Target)",
  "Not Interested", "Mailbox No Longer Active",
  "Automated Error Message", "Automated Catch-All Message",
];

interface TableSpec {
  name: string;
  emailColumn: string;
  triggerColumn: string;       // reply_time / sequence_finished_at / reply_at
  addedColumn: string;         // nurture_added_at / added_at
  skippedColumn: string;       // nurture_skipped / skipped
  safetyColumn?: string;       // nurture_safety (replies, legacy); seq has no safety
  aiCategoryColumn?: string;   // ai_categorized_lead_category / original_ai_category; seq has none
}

const TABLES: TableSpec[] = [
  {
    name: "replies",
    emailColumn: "lead_email",
    triggerColumn: "reply_time",
    addedColumn: "nurture_added_at",
    skippedColumn: "nurture_skipped",
    safetyColumn: "nurture_safety",
    aiCategoryColumn: "ai_categorized_lead_category",
  },
  {
    name: "nurture_legacy_leads",
    emailColumn: "lead_email",
    triggerColumn: "reply_at",
    addedColumn: "nurture_added_at",
    skippedColumn: "nurture_skipped",
    safetyColumn: "nurture_safety",
    aiCategoryColumn: "original_ai_category",
  },
  {
    name: "nurture_sequence_finished",
    emailColumn: "email",
    triggerColumn: "sequence_finished_at",
    addedColumn: "added_at",
    skippedColumn: "skipped",
  },
];

type Tier = 1 | 2 | 3;
const TIER_LABEL: Record<Tier, string> = {
  1: "Ready to nurture (eligible + safe)",
  2: "All eligible (past 45-day cooldown)",
  3: "Waiting (within 45-day cooldown)",
};

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
  const delays = [1000, 2500, 5000, 10000, 20000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === delays.length) {
        console.error(`[${label}] gave up: ${(e as Error)?.message || e}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  return null;
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

/**
 * Fetch (id, email) pairs for one (table, tier) using cursor pagination.
 * Returns the rows so the caller can build an email → [(table, id)] map.
 * UPDATE by primary-key id is O(log N), avoiding the statement timeout
 * we hit when trying ILIKE on the 394k-row legacy table.
 */
async function fetchRowsForTierTable(
  t: TableSpec,
  tier: Tier,
  cutoffIso: string
): Promise<Array<{ id: number; email: string }>> {
  const all: Array<{ id: number; email: string }> = [];
  let lastId = 0;
  while (true) {
    let q = supabase
      .from(t.name)
      .select(`id, ${t.emailColumn}`)
      .is("esp", null)
      .not(t.emailColumn, "is", null)
      .neq(t.emailColumn, "")
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);

    if (tier === 1 || tier === 2) {
      q = q.is(t.addedColumn, null).not(t.skippedColumn, "is", true);
      q = q.lte(t.triggerColumn, cutoffIso);
    } else {
      q = q.gt(t.triggerColumn, cutoffIso);
    }
    if (tier === 1 && t.safetyColumn) {
      q = q.eq(t.safetyColumn, "safe");
    }
    if ((tier === 1 || tier === 2) && t.aiCategoryColumn) {
      q = q.or(
        `${t.aiCategoryColumn}.is.null,${t.aiCategoryColumn}.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`
      );
    }

    const { data, error } = await q;
    if (error) throw new Error(`${t.name} tier-${tier} select failed: ${error.message}`);
    const rows = (data || []) as unknown as Array<{ id: number } & Record<string, string>>;
    if (rows.length === 0) break;
    for (const r of rows) {
      const e = r[t.emailColumn]?.trim().toLowerCase();
      if (e) all.push({ id: r.id, email: e });
    }
    lastId = rows[rows.length - 1].id;
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

interface RowRef { table: string; id: number; }

/**
 * Look up + write ESP for one unique email. Writes go directly to the
 * specific row IDs collected during the scan — primary-key updates are
 * O(log N) regardless of table size, so 394k-row legacy never times out.
 * Cache result so the next tier doesn't re-look-up.
 */
async function processEmail(
  email: string,
  rowsByEmail: Map<string, RowRef[]>,
  cache: Map<string, string | null>
) {
  let host = cache.get(email);
  if (host === undefined) {
    host = await lookupEmailHost(email);
    cache.set(email, host); // even null — don't re-attempt failed addresses this run
  }
  if (!host) return 0;

  const refs = rowsByEmail.get(email) || [];
  // Group by table so we can batch UPDATE WHERE id IN (...)
  const byTable = new Map<string, number[]>();
  for (const r of refs) {
    if (!byTable.has(r.table)) byTable.set(r.table, []);
    byTable.get(r.table)!.push(r.id);
  }

  let written = 0;
  for (const [tableName, ids] of byTable) {
    const result = await withRetry(
      async () => {
        const { error, count } = await supabase
          .from(tableName)
          .update({ esp: host }, { count: "exact" })
          .in("id", ids);
        if (error) throw new Error(error.message);
        return count || 0;
      },
      `update:${tableName}:${email}`
    );
    if (result !== null) written += result;
  }
  return written;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry");
  const resetUnknowns = args.includes("--reset-unknowns");
  const concIdx = args.indexOf("--concurrency");
  const concurrency = concIdx >= 0 ? Math.max(1, Math.min(50, Number(args[concIdx + 1]))) : DEFAULT_CONCURRENCY;
  const tierIdx = args.indexOf("--tier");
  const onlyTier: Tier | null = tierIdx >= 0 ? (Number(args[tierIdx + 1]) as Tier) : null;

  if (!process.env.EMAILGUARD_API_KEY) {
    console.error("EMAILGUARD_API_KEY is not set in .env.local");
    process.exit(1);
  }

  console.log(`\nBackfilling esp${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`Concurrency: ${concurrency}`);
  if (onlyTier) console.log(`Only tier: ${onlyTier} — ${TIER_LABEL[onlyTier]}`);
  console.log("");

  if (resetUnknowns) {
    for (const t of TABLES) {
      console.log(`Resetting Unknown rows in ${t.name}…`);
      const { error, count } = await supabase
        .from(t.name)
        .update({ esp: null }, { count: "exact" })
        .eq("esp", "Unknown");
      if (error) console.error(`  reset failed: ${error.message}`);
      else console.log(`  cleared ${(count || 0).toLocaleString()} rows`);
    }
    console.log("");
  }

  const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const cache = new Map<string, string | null>();
  const tiers: Tier[] = onlyTier ? [onlyTier] : [1, 2, 3];
  const t0 = Date.now();
  let totalEmailsProcessed = 0;
  let totalLookupHits = 0;

  for (const tier of tiers) {
    console.log(`${"═".repeat(60)}`);
    console.log(`Tier ${tier}: ${TIER_LABEL[tier]}`);
    console.log(`${"═".repeat(60)}`);

    // 1. Scan each table — collect (id, email) pairs per row so we can
    //    UPDATE by primary-key id later (avoids ILIKE table scans).
    const rowsByEmail = new Map<string, RowRef[]>();
    let totalRows = 0;
    for (const t of TABLES) {
      console.log(`Scanning ${t.name}…`);
      const rows = await fetchRowsForTierTable(t, tier, cutoffIso);
      for (const r of rows) {
        if (!rowsByEmail.has(r.email)) rowsByEmail.set(r.email, []);
        rowsByEmail.get(r.email)!.push({ table: t.name, id: r.id });
      }
      totalRows += rows.length;
      console.log(`  ${rows.length.toLocaleString()} rows missing esp`);
    }

    const tierEmails = Array.from(rowsByEmail.keys());
    const newEmails = tierEmails.filter((e) => !cache.has(e));
    console.log(`Tier ${tier}: ${tierEmails.length.toLocaleString()} unique emails covering ${totalRows.toLocaleString()} rows (${newEmails.length.toLocaleString()} need lookup, ${(tierEmails.length - newEmails.length).toLocaleString()} cached)`);

    if (dryRun) continue;
    if (tierEmails.length === 0) {
      console.log(`Tier ${tier} has nothing to do — moving on.\n`);
      continue;
    }

    // 2. Process — lookup + immediate UPDATE BY ID per email
    const tierStart = Date.now();
    let processed = 0;
    let written = 0;
    let lookups = 0;

    await runWithConcurrency(
      tierEmails,
      async (email) => {
        const cachedBefore = cache.has(email);
        const w = await processEmail(email, rowsByEmail, cache);
        written += w;
        processed++;
        if (!cachedBefore && cache.get(email)) lookups++;
        if (processed % 100 === 0) {
          const rate = processed / ((Date.now() - tierStart) / 1000);
          const eta = Math.round((tierEmails.length - processed) / rate);
          const etaText = eta < 90 ? `${eta}s` : eta < 3600 ? `${Math.round(eta / 60)}m` : `${(eta / 3600).toFixed(1)}h`;
          console.log(`  Tier ${tier}: ${processed.toLocaleString()} / ${tierEmails.length.toLocaleString()} (${rate.toFixed(1)}/s, ETA ${etaText}, ${written.toLocaleString()} rows written)`);
        }
      },
      concurrency
    );

    const tierSec = ((Date.now() - tierStart) / 1000).toFixed(1);
    console.log(`Tier ${tier} done in ${tierSec}s — ${lookups.toLocaleString()} new ESP lookups, ${written.toLocaleString()} rows updated\n`);
    totalEmailsProcessed += processed;
    totalLookupHits += lookups;
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${"═".repeat(60)}`);
  console.log(`Done in ${totalSec}s`);
  console.log(`  Emails processed: ${totalEmailsProcessed.toLocaleString()}`);
  console.log(`  ESP values written: ${totalLookupHits.toLocaleString()}`);
  console.log(`  Cache hits (skipped re-lookup): ${(cache.size - totalLookupHits).toLocaleString()}`);
}

main().catch((err) => {
  console.error("backfill-esp failed:", err);
  process.exit(1);
});
