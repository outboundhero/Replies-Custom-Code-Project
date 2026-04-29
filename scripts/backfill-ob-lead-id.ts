/**
 * Backfill `ob_lead_id` on every row in `nurture_legacy_leads`.
 *
 * Why: legacy rows came from Airtable and only carry `lead_email`. Every
 * push-to-nurture call has to look up the matching OutboundHero lead via
 * /leads?search=<email> — that lookup dominates push wall time. Storing
 * the resolved ID on the row makes subsequent pushes instant.
 *
 * Design mirrors scripts/backfill-esp.ts:
 *
 *   - PRIORITY TIERS so the most actionable leads get IDs first
 *       Tier 1: Ready to nurture (eligible + safe + not added/skipped)
 *       Tier 2: All eligible (past 45-day cooldown, any safety)
 *       Tier 3: Waiting (within 45-day cooldown)
 *
 *   - INCREMENTAL WRITES: each lookup writes to Supabase immediately, so
 *     a crash mid-run loses nothing.
 *
 *   - PER-EMAIL CACHE so the same address appearing across tiers only
 *     costs one OutboundHero call.
 *
 *   - UPDATE BY id (primary key) — O(log N) regardless of table size.
 *
 *   - On lookup failure leaves ob_lead_id as NULL so the next run picks
 *     it up (matches the ESP backfill behavior — never writes a sentinel
 *     that masks failed lookups).
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/backfill-ob-lead-id.ts
 *   npx tsx --env-file=.env.local scripts/backfill-ob-lead-id.ts --tier 1
 *   npx tsx --env-file=.env.local scripts/backfill-ob-lead-id.ts --concurrency 15
 *   npx tsx --env-file=.env.local scripts/backfill-ob-lead-id.ts --dry
 *
 * Idempotent — re-runs only touch rows where ob_lead_id IS NULL.
 */

import { config } from "dotenv";
import supabase from "../lib/supabase";
import { findLeadByEmail } from "../lib/outboundhero-api";

config({ path: ".env.local" });

const TABLE = "nurture_legacy_leads";
const PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 10; // OB /leads search is ~1-2s per call; 10 keeps wall time reasonable without tripping rate limits
const NURTURE_DAYS = 45;

// Mirror of EXCLUDED_AI_CATEGORIES in /api/nurture/route.ts.
const EXCLUDED_AI_CATEGORIES = [
  "Interested", "Meeting Request", "Meeting Set",
  "Do Not Contact", "Wrong Person", "Wrong Person (Change of Target)",
  "Not Interested", "Mailbox No Longer Active",
  "Automated Error Message", "Automated Catch-All Message",
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
  concurrency: number,
): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx], idx); }
      catch (e) { console.error("[backfill-ob-lead-id] worker error", e); }
    }
  });
  await Promise.all(runners);
}

/** Cursor-paginated fetch of (id, email) pairs for one tier. */
async function fetchRowsForTier(tier: Tier, cutoffIso: string): Promise<Array<{ id: number; email: string }>> {
  const all: Array<{ id: number; email: string }> = [];
  let lastId = 0;
  while (true) {
    let q = supabase
      .from(TABLE)
      .select("id, lead_email")
      .is("ob_lead_id", null)
      .not("lead_email", "is", null)
      .neq("lead_email", "")
      .neq("client_tag", "N/A")
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);

    if (tier === 1 || tier === 2) {
      q = q
        .is("nurture_added_at", null)
        .not("nurture_skipped", "is", true)
        .lte("reply_at", cutoffIso);
    } else {
      q = q.gt("reply_at", cutoffIso);
    }
    if (tier === 1) q = q.eq("nurture_safety", "safe");
    if (tier === 1 || tier === 2) {
      q = q.or(
        `original_ai_category.is.null,original_ai_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`
      );
    }

    const { data, error } = await q;
    if (error) throw new Error(`tier-${tier} select failed: ${error.message}`);
    const rows = (data || []) as unknown as Array<{ id: number; lead_email: string | null }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      const e = r.lead_email?.trim().toLowerCase();
      if (e) all.push({ id: r.id, email: e });
    }
    lastId = rows[rows.length - 1].id;
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * Look up + write ob_lead_id for one unique email. Writes go to every row
 * id holding that email so duplicates collapse to one OutboundHero call.
 * Cache value (including null) so subsequent tiers don't re-query.
 */
async function processEmail(
  email: string,
  rowsByEmail: Map<string, number[]>,
  cache: Map<string, number | null>,
): Promise<{ written: number; lookupFired: boolean }> {
  let cachedId = cache.get(email);
  let lookupFired = false;
  if (cachedId === undefined) {
    lookupFired = true;
    const lead = await withRetry(() => findLeadByEmail(email), `findLeadByEmail:${email}`);
    cachedId = lead?.id ?? null;
    cache.set(email, cachedId);
  }
  if (!cachedId) return { written: 0, lookupFired };

  const ids = rowsByEmail.get(email) || [];
  if (ids.length === 0) return { written: 0, lookupFired };

  const result = await withRetry(
    async () => {
      const { error, count } = await supabase
        .from(TABLE)
        .update({ ob_lead_id: cachedId }, { count: "exact" })
        .in("id", ids);
      if (error) throw new Error(error.message);
      return count || 0;
    },
    `update:${email}`
  );
  return { written: result ?? 0, lookupFired };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry");
  const concIdx = args.indexOf("--concurrency");
  const concurrency = concIdx >= 0
    ? Math.max(1, Math.min(50, Number(args[concIdx + 1])))
    : DEFAULT_CONCURRENCY;
  const tierIdx = args.indexOf("--tier");
  const onlyTier: Tier | null = tierIdx >= 0 ? (Number(args[tierIdx + 1]) as Tier) : null;

  console.log(`\nBackfilling nurture_legacy_leads.ob_lead_id${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`Concurrency: ${concurrency}`);
  if (onlyTier) console.log(`Only tier: ${onlyTier} — ${TIER_LABEL[onlyTier]}`);
  console.log("");

  const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const cache = new Map<string, number | null>();
  const tiers: Tier[] = onlyTier ? [onlyTier] : [1, 2, 3];
  const t0 = Date.now();
  let totalEmailsProcessed = 0;
  let totalLookupHits = 0;
  let totalRowsWritten = 0;

  for (const tier of tiers) {
    console.log(`${"═".repeat(60)}`);
    console.log(`Tier ${tier}: ${TIER_LABEL[tier]}`);
    console.log(`${"═".repeat(60)}`);

    console.log(`Scanning ${TABLE}…`);
    const rows = await fetchRowsForTier(tier, cutoffIso);

    const rowsByEmail = new Map<string, number[]>();
    for (const r of rows) {
      if (!rowsByEmail.has(r.email)) rowsByEmail.set(r.email, []);
      rowsByEmail.get(r.email)!.push(r.id);
    }
    const tierEmails = Array.from(rowsByEmail.keys());
    const newEmails = tierEmails.filter((e) => !cache.has(e));
    console.log(`  ${rows.length.toLocaleString()} rows missing ob_lead_id`);
    console.log(`Tier ${tier}: ${tierEmails.length.toLocaleString()} unique emails (${newEmails.length.toLocaleString()} need lookup, ${(tierEmails.length - newEmails.length).toLocaleString()} cached)`);

    if (dryRun) continue;
    if (tierEmails.length === 0) {
      console.log(`Tier ${tier} has nothing to do — moving on.\n`);
      continue;
    }

    const tierStart = Date.now();
    let processed = 0;
    let written = 0;
    let lookups = 0;
    let resolved = 0;

    await runWithConcurrency(
      tierEmails,
      async (email) => {
        const { written: w, lookupFired } = await processEmail(email, rowsByEmail, cache);
        written += w;
        processed++;
        if (lookupFired) lookups++;
        if (cache.get(email)) resolved++;
        if (processed % 100 === 0) {
          const rate = processed / ((Date.now() - tierStart) / 1000);
          const eta = Math.round((tierEmails.length - processed) / rate);
          const etaText = eta < 90 ? `${eta}s` : eta < 3600 ? `${Math.round(eta / 60)}m` : `${(eta / 3600).toFixed(1)}h`;
          console.log(`  Tier ${tier}: ${processed.toLocaleString()} / ${tierEmails.length.toLocaleString()} (${rate.toFixed(1)}/s, ETA ${etaText}, ${written.toLocaleString()} rows written, ${resolved.toLocaleString()} resolved)`);
        }
      },
      concurrency
    );

    const tierSec = ((Date.now() - tierStart) / 1000).toFixed(1);
    console.log(`Tier ${tier} done in ${tierSec}s — ${lookups.toLocaleString()} new OB lookups, ${written.toLocaleString()} rows updated\n`);
    totalEmailsProcessed += processed;
    totalLookupHits += lookups;
    totalRowsWritten += written;
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${"═".repeat(60)}`);
  console.log(`Done in ${totalSec}s`);
  console.log(`  Emails processed: ${totalEmailsProcessed.toLocaleString()}`);
  console.log(`  OB lookups fired: ${totalLookupHits.toLocaleString()}`);
  console.log(`  Rows updated: ${totalRowsWritten.toLocaleString()}`);
  console.log(`  Cache hits (skipped re-lookup): ${(cache.size - totalLookupHits).toLocaleString()}`);
}

main().catch((err) => {
  console.error("backfill-ob-lead-id failed:", err);
  process.exit(1);
});
