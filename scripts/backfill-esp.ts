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
 * Fetch the email list for one (table, tier) using cursor pagination on
 * id. Each page applies the tier-specific predicate filters.
 */
async function fetchEmailsForTierTable(
  t: TableSpec,
  tier: Tier,
  cutoffIso: string
): Promise<string[]> {
  const all: string[] = [];
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

    // Common filters: not added, not skipped (for tiers 1 & 2)
    if (tier === 1 || tier === 2) {
      q = q
        .is(t.addedColumn, null)
        .not(t.skippedColumn, "is", true);
    }

    // Eligibility (tier 1 & 2 = past cutoff; tier 3 = within cutoff)
    if (tier === 1 || tier === 2) {
      q = q.lte(t.triggerColumn, cutoffIso);
    } else {
      q = q.gt(t.triggerColumn, cutoffIso);
    }

    // Safety: tier 1 requires safe (or seq table which has no safety)
    if (tier === 1 && t.safetyColumn) {
      q = q.eq(t.safetyColumn, "safe");
    }

    // AI-category exclusions (replies + legacy)
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
      if (e) all.push(e);
    }
    lastId = rows[rows.length - 1].id;
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * Look up + write ESP for a single email across ALL tables that contain
 * it. Cache result so the next tier doesn't re-look-up. Per-table
 * UPDATE is wrapped in withRetry to survive transient Supabase errors.
 */
async function processEmail(email: string, cache: Map<string, string | null>) {
  if (cache.has(email)) {
    // Already looked up in a previous tier; if we got a host, write it
    // anywhere it might still be missing (other tables not yet updated).
    const host = cache.get(email);
    if (!host) return;
    await writeHostToAllTables(email, host);
    return;
  }
  const host = await lookupEmailHost(email);
  cache.set(email, host); // even null — don't re-look-up failed addresses in this run
  if (!host) return;
  await writeHostToAllTables(email, host);
}

async function writeHostToAllTables(email: string, host: string) {
  for (const t of TABLES) {
    await withRetry(
      async () => {
        const { error } = await supabase
          .from(t.name)
          .update({ esp: host })
          .ilike(t.emailColumn, email)
          .is("esp", null);
        if (error) throw new Error(error.message);
      },
      `update:${t.name}:${email}`
    );
  }
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

    // 1. Scan each table for this tier's emails
    const tierEmails = new Set<string>();
    for (const t of TABLES) {
      console.log(`Scanning ${t.name}…`);
      const emails = await fetchEmailsForTierTable(t, tier, cutoffIso);
      for (const e of emails) tierEmails.add(e);
      console.log(`  ${emails.length.toLocaleString()} rows missing esp`);
    }

    // 2. Filter out already-cached (already looked up in a previous tier)
    const newEmails = Array.from(tierEmails).filter((e) => !cache.has(e));
    const reusedEmails = tierEmails.size - newEmails.length;
    console.log(`Tier ${tier}: ${tierEmails.size.toLocaleString()} unique emails (${newEmails.length.toLocaleString()} new, ${reusedEmails.toLocaleString()} from cache)`);

    if (dryRun) continue;

    // 3. Process — lookup + immediate write per email
    const tierStart = Date.now();
    let processed = 0;
    let hits = 0;

    await runWithConcurrency(
      Array.from(tierEmails),
      async (email) => {
        const cachedBefore = cache.has(email);
        await processEmail(email, cache);
        processed++;
        if (!cachedBefore && cache.get(email)) hits++;
        if (processed % 100 === 0) {
          const rate = processed / ((Date.now() - tierStart) / 1000);
          const eta = Math.round((tierEmails.size - processed) / rate);
          const etaText = eta < 90 ? `${eta}s` : eta < 3600 ? `${Math.round(eta / 60)}m` : `${(eta / 3600).toFixed(1)}h`;
          console.log(`  Tier ${tier}: ${processed.toLocaleString()} / ${tierEmails.size.toLocaleString()} (${rate.toFixed(1)}/s, ETA ${etaText})`);
        }
      },
      concurrency
    );

    const tierSec = ((Date.now() - tierStart) / 1000).toFixed(1);
    console.log(`Tier ${tier} done in ${tierSec}s — ${hits.toLocaleString()} new ESP values written this tier\n`);
    totalEmailsProcessed += processed;
    totalLookupHits += hits;
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
