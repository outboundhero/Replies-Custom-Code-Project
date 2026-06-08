/**
 * Nurture funnel diagnostic for any single client tag.
 *
 * Run:  npx tsx scripts/nurture-funnel.ts JPH
 *
 * For the given client, breaks the journey from "contacted in Bison" → "Ready
 * to nurture" tile count into every named filter so the operator can see
 * exactly where the leads disappear. Read-only, no mutations.
 *
 * Mirrors the queries in /app/api/nurture/counts/route.ts so the numbers it
 * prints match the tile counts exactly.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
// Lazy-load anything that touches lib/db so env vars are populated first.
import supabase from "../lib/supabase";
import { createClient } from "@libsql/client";

const NURTURE_DAYS = 45;
const EXCLUDED_AI_CATEGORIES = [
  "Interested", "Meeting Request", "Meeting Set", "Do Not Contact",
  "Wrong Person", "Wrong Person (Change of Target)", "Not Interested",
  "Mailbox No Longer Active", "Automated Error Message",
  "Automated Catch-All Message", "Referral Given", "Internally Forwarded",
];

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const CLIENT_TAG = (process.argv[2] || "JPH").toUpperCase();

function header(text: string) {
  console.log("\n" + "=".repeat(70));
  console.log(text);
  console.log("=".repeat(70));
}
function row(label: string, n: number | string) {
  console.log(`  ${label.padEnd(54)} ${String(n).padStart(10)}`);
}

async function countReplies(extra: (q: ReturnType<typeof baseReplies>) => ReturnType<typeof baseReplies>): Promise<number> {
  const { count, error } = await extra(baseReplies());
  if (error) { console.error("query failed:", error.message); return -1; }
  return count ?? 0;
}
function baseReplies() {
  return supabase
    .from("replies")
    .select("id", { count: "exact", head: true })
    .eq("client_tag", CLIENT_TAG);
}

async function countSeq(extra: (q: ReturnType<typeof baseSeq>) => ReturnType<typeof baseSeq>): Promise<number> {
  const { count, error } = await extra(baseSeq());
  if (error) { console.error("query failed:", error.message); return -1; }
  return count ?? 0;
}
function baseSeq() {
  return supabase
    .from("nurture_sequence_finished")
    .select("id", { count: "exact", head: true })
    .eq("client_tag", CLIENT_TAG);
}

async function countLegacy(extra: (q: ReturnType<typeof baseLegacy>) => ReturnType<typeof baseLegacy>): Promise<number> {
  const { count, error } = await extra(baseLegacy());
  if (error) { console.error("query failed:", error.message); return -1; }
  return count ?? 0;
}
function baseLegacy() {
  return supabase
    .from("nurture_legacy_leads")
    .select("id", { count: "exact", head: true })
    .eq("client_tag", CLIENT_TAG);
}

async function safetyBreakdown(): Promise<{ safe: number; unsafe: number; unknown: number; null_: number }> {
  const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const out = { safe: 0, unsafe: 0, unknown: 0, null_: 0 };
  for (const v of ["safe", "unsafe", "unknown"] as const) {
    const { count } = await baseReplies()
      .not("reply_we_got", "is", null).neq("reply_we_got", "")
      .not("reply_time", "is", null)
      .or(`ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`)
      .lte("reply_time", cutoffIso)
      .is("nurture_added_at", null)
      .not("nurture_skipped", "is", true)
      .eq("nurture_safety", v);
    out[v] = count ?? 0;
  }
  const { count: nullCount } = await baseReplies()
    .not("reply_we_got", "is", null).neq("reply_we_got", "")
    .not("reply_time", "is", null)
    .or(`ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`)
    .lte("reply_time", cutoffIso)
    .is("nurture_added_at", null)
    .not("nurture_skipped", "is", true)
    .is("nurture_safety", null);
  out.null_ = nullCount ?? 0;
  return out;
}

async function bucketBreakdown(): Promise<Record<string, number>> {
  const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const buckets: Record<string, number> = {};
  for (const b of ["soft_negative", "out_of_office", "other"]) {
    const { count } = await baseReplies()
      .not("reply_we_got", "is", null).neq("reply_we_got", "")
      .not("reply_time", "is", null)
      .or(`ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`)
      .lte("reply_time", cutoffIso)
      .is("nurture_added_at", null)
      .not("nurture_skipped", "is", true)
      .eq("nurture_bucket", b);
    buckets[b] = count ?? 0;
  }
  const { count: nullCount } = await baseReplies()
    .not("reply_we_got", "is", null).neq("reply_we_got", "")
    .not("reply_time", "is", null)
    .or(`ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`)
    .lte("reply_time", cutoffIso)
    .is("nurture_added_at", null)
    .not("nurture_skipped", "is", true)
    .is("nurture_bucket", null);
  buckets["null"] = nullCount ?? 0;
  return buckets;
}

async function main() {
  console.log(`\nNurture funnel diagnostic for ${CLIENT_TAG}\n`);
  console.log(`(Numbers match the /api/nurture/counts logic. Cutoff = ${NURTURE_DAYS} days.)\n`);

  const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // ── Source 1: nurture_sequence_finished ──
  header(`Source 1: nurture_sequence_finished  (graduated, never replied)`);
  const seqTotal = await countSeq((q) => q);
  const seqEligible = await countSeq((q) => q.lte("sequence_finished_at", cutoffIso).is("added_at", null).not("skipped", "is", true));
  const seqWaiting = await countSeq((q) => q.gt("sequence_finished_at", cutoffIso).is("added_at", null).not("skipped", "is", true));
  const seqAdded = await countSeq((q) => q.not("added_at", "is", null));
  const seqSkipped = await countSeq((q) => q.eq("skipped", true));
  row("Total rows for this client", seqTotal);
  row("Already pushed (added_at NOT NULL)", seqAdded);
  row("Marked skipped", seqSkipped);
  row("Waiting on 45-day cooldown", seqWaiting);
  row("→ Counted in 'Ready' tile (seqEligible)", seqEligible);

  // ── Source 2: replies (soft-negative + out-of-office) ──
  header(`Source 2: replies  (soft-negative + OOO)`);
  const replyTotal = await countReplies((q) =>
    q.not("reply_we_got", "is", null).neq("reply_we_got", "").not("reply_time", "is", null)
  );
  const replyAfterCat = await countReplies((q) =>
    q.not("reply_we_got", "is", null).neq("reply_we_got", "").not("reply_time", "is", null)
     .or(`ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`)
  );
  const replyEligible = await countReplies((q) =>
    q.not("reply_we_got", "is", null).neq("reply_we_got", "").not("reply_time", "is", null)
     .or(`ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`)
     .lte("reply_time", cutoffIso).is("nurture_added_at", null).not("nurture_skipped", "is", true)
  );
  const replyEligibleSafe = await countReplies((q) =>
    q.not("reply_we_got", "is", null).neq("reply_we_got", "").not("reply_time", "is", null)
     .or(`ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`)
     .lte("reply_time", cutoffIso).is("nurture_added_at", null).not("nurture_skipped", "is", true)
     .eq("nurture_safety", "safe")
  );
  const replyAdded = await countReplies((q) => q.not("nurture_added_at", "is", null));
  const replySkipped = await countReplies((q) => q.eq("nurture_skipped", true));
  const replyWaiting = await countReplies((q) =>
    q.not("reply_we_got", "is", null).neq("reply_we_got", "").not("reply_time", "is", null)
     .or(`ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`)
     .gt("reply_time", cutoffIso).is("nurture_added_at", null).not("nurture_skipped", "is", true)
  );
  row("Total reply rows for this client", replyTotal);
  row("Lost to hard-block AI categories", replyTotal - replyAfterCat);
  row("Waiting on 45-day cooldown", replyWaiting);
  row("Already pushed (nurture_added_at NOT NULL)", replyAdded);
  row("Marked skipped (nurture_skipped = true)", replySkipped);
  row("Eligible (before safety filter)", replyEligible);
  row("→ Counted in 'Ready' tile (eligible + safe)", replyEligibleSafe);

  const buckets = await bucketBreakdown();
  console.log("\n  Eligible nurture_bucket breakdown:");
  for (const [b, n] of Object.entries(buckets)) row(`  ${b}`, n);

  const safety = await safetyBreakdown();
  console.log("\n  Eligible nurture_safety breakdown:");
  row("  safe   (counts in Ready)", safety.safe);
  row("  unsafe (excluded)", safety.unsafe);
  row("  unknown (excluded)", safety.unknown);
  row("  NULL   (not classified yet)", safety.null_);

  // ── Source 3: nurture_legacy_leads ──
  header(`Source 3: nurture_legacy_leads  (Airtable backfill)`);
  const legacyTotal = await countLegacy((q) => q);
  const legacyEligibleSafe = await countLegacy((q) =>
    q.or(`original_ai_category.is.null,original_ai_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`)
     .lte("reply_at", cutoffIso).is("nurture_added_at", null).not("nurture_skipped", "is", true)
     .eq("nurture_safety", "safe")
  );
  const legacyAdded = await countLegacy((q) => q.not("nurture_added_at", "is", null));
  row("Total rows for this client", legacyTotal);
  row("Already pushed", legacyAdded);
  row("→ Counted in 'Ready' tile (legacyEligibleSafe)", legacyEligibleSafe);

  // ── Reconciliation against Bison ──
  header(`Reconciliation against Bison`);
  const ready = seqEligible + replyEligibleSafe + legacyEligibleSafe;
  row("→ TOTAL 'Ready to nurture' tile value", ready);

  console.log("\n  Bison side (live API call to instance for this client)...");
  // Dynamic-import so lib/db.ts init runs AFTER dotenv has loaded env vars.
  const { resolveInstanceForClient } = await import("../lib/bison-instances");
  const { listCampaigns } = await import("../lib/outboundhero-api");
  const instanceKey = await resolveInstanceForClient(CLIENT_TAG);
  console.log(`  Bison instance: ${instanceKey}`);
  try {
    const allCampaigns = await listCampaigns(instanceKey, { nameContains: `${CLIENT_TAG}:` });
    if (allCampaigns.length === 0) {
      console.log(`  ⚠️  No Bison campaigns matched "${CLIENT_TAG}:"`);
    } else {
      let bisonTotalLeads = 0;
      let bisonReplied = 0;
      let bisonBounced = 0;
      console.log("");
      console.log(`  ${"campaign".padEnd(46)} ${"status".padEnd(10)} ${"leads".padStart(7)} ${"replied".padStart(8)} ${"bounced".padStart(8)}`);
      for (const c of allCampaigns) {
        const name = (c.name || "(unnamed)").slice(0, 44).padEnd(46);
        bisonTotalLeads += c.total_leads || 0;
        bisonReplied += c.replied || 0;
        bisonBounced += c.bounced || 0;
        console.log(`  ${name} ${(c.status || "—").padEnd(10)} ${String(c.total_leads || 0).padStart(7)} ${String(c.replied || 0).padStart(8)} ${String(c.bounced || 0).padStart(8)}`);
      }
      console.log("  " + "─".repeat(80));
      row("Bison total leads across all campaigns", bisonTotalLeads);
      row("Bison total replied", bisonReplied);
      row("Bison total bounced", bisonBounced);
      const inSequenceEstimate = bisonTotalLeads - bisonReplied - bisonBounced - seqTotal;
      row("Estimated still in sequence (not graduated)", Math.max(0, inSequenceEstimate));
      console.log("");
      row("Gap (Bison contacted) − (Ready to nurture)", bisonTotalLeads - ready);
    }
  } catch (e) {
    console.log(`  Bison call failed: ${(e as Error).message}`);
  }

  // ── Global sync health (across ALL clients) ──
  header(`Global nurture_sequence_finished sync health`);
  const { count: globalSeqTotal } = await supabase
    .from("nurture_sequence_finished")
    .select("id", { count: "exact", head: true });
  const { data: latest } = await supabase
    .from("nurture_sequence_finished")
    .select("synced_at, client_tag, campaign_name")
    .order("synced_at", { ascending: false })
    .limit(1);
  row("Total rows across ALL clients", globalSeqTotal ?? 0);
  if (latest && latest.length > 0) {
    console.log(`  Most recent sync wrote a row at: ${latest[0].synced_at}`);
    console.log(`  Most recent row's client_tag:   ${latest[0].client_tag}`);
    console.log(`  Most recent row's campaign:     ${latest[0].campaign_name}`);
  } else {
    console.log("  ⚠️  Table is empty across ALL clients — sync has never produced rows.");
  }

  // Sanity check: write activity in the last 24h. If 0, the cron may
  // have stopped firing entirely.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: last24h } = await supabase
    .from("nurture_sequence_finished")
    .select("id", { count: "exact", head: true })
    .gte("synced_at", dayAgo);
  row("Rows written in the last 24h", last24h ?? 0);

  console.log("\nDone.\n");
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
