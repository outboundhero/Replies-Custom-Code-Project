/**
 * Rollback recently-marked-added nurture leads.
 *
 * Use case: a push-to-nurture call returned 200 OK but OutboundHero silently
 * dropped most of the leads (e.g. because allow_parallel_sending was false
 * and the leads were already in another active campaign). Our DB recorded
 * them as "added" — this script reverses that so they reappear in
 * "Ready to Nurture".
 *
 * Default = dry-run. Pass --commit to actually update.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/rollback-recent-nurture-adds.ts \
 *     --client JPCNJ --minutes 30
 *
 *   npx tsx --env-file=.env.local scripts/rollback-recent-nurture-adds.ts \
 *     --client JPCNJ --minutes 30 --commit
 *
 * Options:
 *   --client <tag>      client_tag filter (required, e.g. JPCNJ)
 *   --minutes <n>       look back this many minutes (default 60)
 *   --campaign <id>     restrict to a specific nurture_campaign_id (optional)
 *   --commit            actually perform the update (otherwise dry-run)
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function parseArg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

const clientTag = parseArg("client");
const minutesStr = parseArg("minutes") || "60";
const campaignIdStr = parseArg("campaign");
const commit = process.argv.includes("--commit");

if (!clientTag) {
  console.error("ERROR: --client <tag> required");
  process.exit(1);
}

const minutes = Number(minutesStr);
if (!Number.isFinite(minutes) || minutes <= 0) {
  console.error("ERROR: --minutes must be a positive number");
  process.exit(1);
}
const campaignId = campaignIdStr ? Number(campaignIdStr) : null;

const cutoffIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

console.log(`\nRollback parameters:`);
console.log(`  client_tag         = ${clientTag}`);
console.log(`  added_at >=        = ${cutoffIso}  (last ${minutes} minutes)`);
console.log(`  nurture_campaign_id= ${campaignId ?? "(any)"}`);
console.log(`  mode               = ${commit ? "COMMIT (will update DB)" : "DRY-RUN (read only)"}`);
console.log("");

async function inspect(
  table: "replies" | "nurture_legacy_leads" | "nurture_sequence_finished",
  addedAtCol: string,
  campaignCol: string,
  emailCol: string,
) {
  let q = supabase
    .from(table)
    .select(`id, ${emailCol}, client_tag, ${addedAtCol}, ${campaignCol}`)
    .eq("client_tag", clientTag)
    .gte(addedAtCol, cutoffIso)
    .not(addedAtCol, "is", null);
  if (campaignId !== null) q = q.eq(campaignCol, campaignId);
  const { data, error } = await q;
  if (error) {
    console.error(`[${table}] select failed:`, error.message);
    return [];
  }
  return (data || []) as unknown as Array<{ id: number; lead_email: string | null }>;
}

async function main() {
  const replies = await inspect("replies", "nurture_added_at", "nurture_campaign_id", "lead_email");
  const legacy = await inspect("nurture_legacy_leads", "nurture_added_at", "nurture_campaign_id", "lead_email");
  // nurture_sequence_finished stores the address in `email`, NOT `lead_email`
  // — passing the wrong column made this select fail silently and return 0,
  // so seq leads (the bulk of the pool) were never rolled back.
  const seq = await inspect("nurture_sequence_finished", "added_at", "nurture_campaign_id", "email");

  console.log(`Found:`);
  console.log(`  replies:                  ${replies.length}`);
  console.log(`  nurture_legacy_leads:     ${legacy.length}`);
  console.log(`  nurture_sequence_finished:${seq.length}`);
  console.log(`  TOTAL:                    ${replies.length + legacy.length + seq.length}`);
  console.log("");

  if (replies.length + legacy.length + seq.length === 0) {
    console.log("Nothing matches. Exiting.");
    return;
  }

  // Show sample
  const sampleEmails = [...replies, ...legacy, ...seq].slice(0, 10).map((r) => r.lead_email);
  console.log(`Sample emails (first 10):`);
  for (const e of sampleEmails) console.log(`  - ${e}`);
  console.log("");

  if (!commit) {
    console.log("DRY-RUN: no changes made. Re-run with --commit to actually clear nurture_added_at + nurture_campaign_id on these rows.");
    return;
  }

  console.log("COMMITTING rollback…");

  if (replies.length) {
    const ids = replies.map((r) => r.id);
    const { error } = await supabase
      .from("replies")
      .update({ nurture_added_at: null, nurture_campaign_id: null })
      .in("id", ids);
    if (error) throw new Error(`replies update failed: ${error.message}`);
    console.log(`  replies: cleared ${ids.length} rows`);
  }
  if (legacy.length) {
    const ids = legacy.map((r) => r.id);
    const { error } = await supabase
      .from("nurture_legacy_leads")
      .update({ nurture_added_at: null, nurture_campaign_id: null })
      .in("id", ids);
    if (error) throw new Error(`legacy update failed: ${error.message}`);
    console.log(`  nurture_legacy_leads: cleared ${ids.length} rows`);
  }
  if (seq.length) {
    const ids = seq.map((r) => r.id);
    const { error } = await supabase
      .from("nurture_sequence_finished")
      .update({ added_at: null, nurture_campaign_id: null })
      .in("id", ids);
    if (error) throw new Error(`seq update failed: ${error.message}`);
    console.log(`  nurture_sequence_finished: cleared ${ids.length} rows`);
  }

  console.log("\nDone. Refresh the Nurture page — Ready-to-Nurture count should reflect the rollback.");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
