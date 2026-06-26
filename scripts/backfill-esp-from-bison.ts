/**
 * Backfill `esp` column on existing rows using Bison's own tag set
 * (replaces the older EmailGuard-based scripts/backfill-esp.ts).
 *
 * Three priority tiers — matching the operator's preferred order so the
 * useful pool gets backfilled FIRST and the operator can start using
 * Auto-route immediately:
 *
 *   Tier 1 — Ready leads:   eligible (past cooldown) + safe + not pushed
 *                           + not skipped  AND  esp IS NULL.
 *                           These are what the Auto-route button needs.
 *
 *   Tier 2 — Waiting leads: not yet past the 45-day cooldown but will be
 *                           soon. ESP-fill these so they're routable the
 *                           moment they roll over.
 *
 *   Tier 3 — Already pushed: historical record only. Low priority — does
 *                            not affect any operator workflow today.
 *
 * The script hits Bison via findLeadByEmail (bounded concurrency 5) and
 * caches results in-memory so repeat emails inside a single tier don't
 * re-query. Writes are immediate per-lead so a crash mid-tier doesn't
 * lose progress.
 *
 *   Run order:
 *     npx tsx scripts/backfill-esp-from-bison.ts --tier 1
 *     npx tsx scripts/backfill-esp-from-bison.ts --tier 2
 *     npx tsx scripts/backfill-esp-from-bison.ts --tier 3
 *
 *   Defaults to --tier 1 if no flag passed.
 *   Pass --client TAG to scope to a single client (useful for first tests).
 *   Pass --dry-run to print what would happen without writing.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
// Anything that touches lib/db (which initializes Turso at module-load
// using process.env.TURSO_DATABASE_URL) must be dynamic-imported AFTER
// dotenv has populated env. lib/supabase is fine — it uses a lazy proxy
// — and lib/nurture/esp has no env deps.
import supabase from "../lib/supabase";
import { pickEspFromTags, detectCampaignEsp, detectEsp } from "../lib/nurture/esp";

const args = process.argv.slice(2);
const TIER = (() => {
  const i = args.indexOf("--tier");
  if (i < 0) return 1;
  return Number(args[i + 1]) || 1;
})();
const CLIENT_FILTER = (() => {
  const i = args.indexOf("--client");
  return i >= 0 ? args[i + 1]?.toUpperCase() : undefined;
})();
const DRY_RUN = args.includes("--dry-run");
// Final fallback: when neither a Bison tag NOR an ESP-bearing campaign name
// resolves, stamp detectEsp(email) — the SAME default routing uses at runtime
// for a NULL esp (consumer-Outlook domains → outlook, else google). Behaviour-
// neutral, but it fills 100% of leads and stops re-fetching the unresolvable
// tail every run. Off by default (keeps no-signal rows NULL & upgradable).
const DEFAULT_FALLBACK = args.includes("--default-fallback");
const CONCURRENCY = 5;
const NURTURE_DAYS = 45;

const EXCLUDED_AI_CATEGORIES = [
  "Interested", "Meeting Request", "Meeting Set", "Do Not Contact",
  "Wrong Person", "Wrong Person (Change of Target)", "Not Interested",
  "Mailbox No Longer Active", "Automated Error Message",
  "Automated Catch-All Message", "Referral Given", "Internally Forwarded",
];

interface Job {
  source: "seq" | "reply" | "legacy";
  rowId: number;
  email: string;
  clientTag: string | null;
  campaignName?: string | null; // for the no-tag fallback (seq/replies only)
}

const espCache = new Map<string, string | null>(); // email → tag name or null

// Lazy holders for the Bison helpers (loaded after dotenv).
let _resolveInstanceForClient: ((tag: string) => Promise<string>) | null = null;
let _findLeadByEmail: ((instance: string, email: string) => Promise<{ tags?: Array<{ id?: number; name?: string; default?: boolean }> } | null>) | null = null;
async function loadBisonHelpers() {
  if (_resolveInstanceForClient && _findLeadByEmail) return;
  const bisonInstances = await import("../lib/bison-instances");
  const bisonApi = await import("../lib/outboundhero-api");
  _resolveInstanceForClient = bisonInstances.resolveInstanceForClient as typeof _resolveInstanceForClient;
  _findLeadByEmail = bisonApi.findLeadByEmail as typeof _findLeadByEmail;
}

async function lookupEsp(email: string, clientTag: string | null): Promise<string | null> {
  const cached = espCache.get(email);
  if (cached !== undefined) return cached;
  await loadBisonHelpers();
  let instance: string = "outboundhero";
  if (clientTag) {
    try { instance = await _resolveInstanceForClient!(clientTag); } catch { /* default */ }
  }
  try {
    const lead = await _findLeadByEmail!(instance, email);
    const esp = pickEspFromTags(lead?.tags);
    espCache.set(email, esp);
    return esp;
  } catch (e) {
    console.warn(`  lookup failed for ${email}: ${(e as Error).message}`);
    espCache.set(email, null);
    return null;
  }
}

async function runWorkerPool(jobs: Job[]): Promise<{ filled: number; skipped: number; fromTag: number; fromCampaign: number; fromDefault: number }> {
  let filled = 0, skipped = 0, fromTag = 0, fromCampaign = 0, fromDefault = 0;
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      while (idx < jobs.length) {
        const j = jobs[idx++];
        // 1) Bison tag = the accurate signal (splits google/outlook/segs).
        const tagEsp = await lookupEsp(j.email, j.clientTag);
        // 2) Fallback: derive from the row's OWN campaign name (no Bison /
        //    EmailGuard call). The lead is then explicitly filled instead of
        //    left NULL & re-fetched every run; matches the route-time default.
        const campEsp = j.campaignName ? detectCampaignEsp(j.campaignName) : null;
        const esp = tagEsp || campEsp || (DEFAULT_FALLBACK ? detectEsp(j.email) : null);
        if (!esp) { skipped++; continue; }
        if (tagEsp) fromTag++; else if (campEsp) fromCampaign++; else fromDefault++;
        const src = tagEsp ? "tag" : campEsp ? "campaign" : "default";
        if (DRY_RUN) {
          console.log(`  [dry] ${j.source} id=${j.rowId} ${j.email} → ${esp} (${src})`);
          filled++;
          continue;
        }
        const table = j.source === "seq" ? "nurture_sequence_finished"
                    : j.source === "reply" ? "replies"
                    : "nurture_legacy_leads";
        const { error } = await supabase.from(table).update({ esp }).eq("id", j.rowId);
        if (error) {
          console.warn(`  write failed ${table} id=${j.rowId}: ${error.message}`);
        } else {
          filled++;
          if (filled % 25 === 0) console.log(`  …filled ${filled} so far (${idx}/${jobs.length} jobs)`);
        }
      }
    }),
  );
  return { filled, skipped, fromTag, fromCampaign, fromDefault };
}

async function fetchTier1(cutoffIso: string): Promise<Job[]> {
  console.log(`Tier 1 query — Ready (past cooldown + safe + not pushed + esp NULL)…`);
  const jobs: Job[] = [];
  // seq: no safety classifier — eligible = past cooldown + not added/skipped + esp NULL
  let q = supabase.from("nurture_sequence_finished")
    .select("id, email, client_tag, campaign_name")
    .is("esp", null)
    .lte("sequence_finished_at", cutoffIso)
    .is("added_at", null)
    .not("skipped", "is", true);
  if (CLIENT_FILTER) q = q.eq("client_tag", CLIENT_FILTER);
  const { data: seqRows } = await q.limit(5000);
  for (const r of seqRows || []) {
    if (!r.email) continue;
    jobs.push({ source: "seq", rowId: r.id as number, email: r.email as string, clientTag: r.client_tag as string | null, campaignName: r.campaign_name as string | null });
  }
  // replies: safety = safe + past cooldown + not added/skipped + esp NULL
  let qr = supabase.from("replies")
    .select("id, lead_email, client_tag, campaign_name")
    .is("esp", null)
    .eq("nurture_safety", "safe")
    .lte("reply_time", cutoffIso)
    .is("nurture_added_at", null)
    .not("nurture_skipped", "is", true)
    .not("reply_we_got", "is", null).neq("reply_we_got", "")
    .or(`ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`);
  if (CLIENT_FILTER) qr = qr.eq("client_tag", CLIENT_FILTER);
  const { data: replyRows } = await qr.limit(5000);
  for (const r of replyRows || []) {
    if (!r.lead_email) continue;
    jobs.push({ source: "reply", rowId: r.id as number, email: r.lead_email as string, clientTag: r.client_tag as string | null, campaignName: r.campaign_name as string | null });
  }
  // legacy: safety = safe + past cooldown + not added/skipped + esp NULL
  let ql = supabase.from("nurture_legacy_leads")
    .select("id, lead_email, client_tag")
    .is("esp", null)
    .eq("nurture_safety", "safe")
    .lte("reply_at", cutoffIso)
    .is("nurture_added_at", null)
    .not("nurture_skipped", "is", true);
  if (CLIENT_FILTER) ql = ql.eq("client_tag", CLIENT_FILTER);
  const { data: legacyRows } = await ql.limit(5000);
  for (const r of legacyRows || []) {
    if (!r.lead_email) continue;
    jobs.push({ source: "legacy", rowId: r.id as number, email: r.lead_email as string, clientTag: r.client_tag as string | null });
  }
  return jobs;
}

async function fetchTier2(cutoffIso: string): Promise<Job[]> {
  console.log(`Tier 2 query — Waiting (BEFORE cooldown, will be Ready soon)…`);
  const jobs: Job[] = [];
  let q = supabase.from("nurture_sequence_finished")
    .select("id, email, client_tag, campaign_name")
    .is("esp", null)
    .gt("sequence_finished_at", cutoffIso)
    .is("added_at", null);
  if (CLIENT_FILTER) q = q.eq("client_tag", CLIENT_FILTER);
  const { data: seqRows } = await q.limit(5000);
  for (const r of seqRows || []) {
    if (!r.email) continue;
    jobs.push({ source: "seq", rowId: r.id as number, email: r.email as string, clientTag: r.client_tag as string | null, campaignName: r.campaign_name as string | null });
  }
  let qr = supabase.from("replies")
    .select("id, lead_email, client_tag, campaign_name")
    .is("esp", null)
    .gt("reply_time", cutoffIso)
    .is("nurture_added_at", null);
  if (CLIENT_FILTER) qr = qr.eq("client_tag", CLIENT_FILTER);
  const { data: replyRows } = await qr.limit(5000);
  for (const r of replyRows || []) {
    if (!r.lead_email) continue;
    jobs.push({ source: "reply", rowId: r.id as number, email: r.lead_email as string, clientTag: r.client_tag as string | null, campaignName: r.campaign_name as string | null });
  }
  return jobs;
}

async function fetchTier3(): Promise<Job[]> {
  console.log(`Tier 3 query — Already-pushed historical (low priority)…`);
  const jobs: Job[] = [];
  let q = supabase.from("nurture_sequence_finished")
    .select("id, email, client_tag, campaign_name")
    .is("esp", null)
    .not("added_at", "is", null);
  if (CLIENT_FILTER) q = q.eq("client_tag", CLIENT_FILTER);
  const { data: seqRows } = await q.limit(5000);
  for (const r of seqRows || []) {
    if (!r.email) continue;
    jobs.push({ source: "seq", rowId: r.id as number, email: r.email as string, clientTag: r.client_tag as string | null, campaignName: r.campaign_name as string | null });
  }
  let qr = supabase.from("replies")
    .select("id, lead_email, client_tag, campaign_name")
    .is("esp", null)
    .not("nurture_added_at", "is", null);
  if (CLIENT_FILTER) qr = qr.eq("client_tag", CLIENT_FILTER);
  const { data: replyRows } = await qr.limit(5000);
  for (const r of replyRows || []) {
    if (!r.lead_email) continue;
    jobs.push({ source: "reply", rowId: r.id as number, email: r.lead_email as string, clientTag: r.client_tag as string | null, campaignName: r.campaign_name as string | null });
  }
  return jobs;
}

async function main() {
  const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  console.log(`Backfill ESP from Bison — tier=${TIER}${CLIENT_FILTER ? ` client=${CLIENT_FILTER}` : ""}${DRY_RUN ? " [dry-run]" : ""}`);
  console.log(`Cutoff: ${cutoffIso}\n`);

  let jobs: Job[] = [];
  if (TIER === 1) jobs = await fetchTier1(cutoffIso);
  else if (TIER === 2) jobs = await fetchTier2(cutoffIso);
  else if (TIER === 3) jobs = await fetchTier3();
  else { console.error("Unknown tier; use 1, 2, or 3"); process.exit(1); }

  console.log(`Found ${jobs.length} jobs. Running ${CONCURRENCY} parallel lookups…\n`);
  if (jobs.length === 0) { console.log("Nothing to do."); return; }

  const { filled, skipped, fromTag, fromCampaign, fromDefault } = await runWorkerPool(jobs);

  console.log(`\nDone.`);
  console.log(`  filled:  ${filled}  (from Bison tag: ${fromTag}, from campaign name: ${fromCampaign}, from email default: ${fromDefault})`);
  console.log(`  skipped: ${skipped}  (no Bison tag AND no ESP-bearing campaign name — e.g. legacy rows with no campaign_name, or an un-ESP-named campaign)`);
  console.log(`  total:   ${jobs.length}`);
  console.log(`\nTip: run \`npx tsx scripts/backfill-esp-from-bison.ts --tier ${TIER + 1}\` next.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
