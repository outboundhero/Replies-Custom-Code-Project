/**
 * One-time backfill: for leads from the last 24h whose AI-suggested category is
 * "Referral Given", prepare the Send Reply section — populate the resolved
 * client reply template (variables mapped) + CC + BCC — in BOTH Supabase
 * (ReplyRouter) and the corresponding Airtable record. Nothing is sent, and the
 * AI category / lead category are left untouched.
 *
 *   dry run:  tsx --env-file=.env.local scripts/backfill-referral-templates.ts
 *   apply:    tsx --env-file=.env.local scripts/backfill-referral-templates.ts --apply
 */
import supabase from "@/lib/supabase";
import db from "@/lib/db";
import { resolveTemplate } from "@/lib/processing/template-resolver";
import { stripQuotedHistory } from "@/lib/qualification/strip-quoted";
import { updateRecord } from "@/lib/airtable";

const AIRTABLE_TABLE_ID = "tbl1BnpnsUBrBGeuy"; // shared across all section bases
const CONCURRENCY = 5;
const APPLY = process.argv.includes("--apply");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getConfig(tag: string): Promise<Record<string, any> | null> {
  const r = await db.execute({ sql: "SELECT * FROM client_config WHERE client_tag = ?", args: [tag] });
  return (r.rows[0] as Record<string, unknown>) || null;
}

async function main() {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase.from("replies")
    .select("id, client_tag, first_name, lead_name, company_name, phone, sender_name, reply_we_got, email_subject, our_reply, airtable_record_id, airtable_base_id, lead_category, ai_categorized_lead_category")
    .eq("ai_categorized_lead_category", "Referral Given")
    .gte("created_at", since);
  if (error) throw new Error(error.message);
  const leads = (data || []).filter((r) => r.client_tag && r.client_tag !== "N/A");
  const skippedNA = (data || []).length - leads.length;
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} · matched ${data?.length} · backfilling ${leads.length} (skipped ${skippedNA} N/A)\n`);

  const configCache = new Map<string, Record<string, unknown> | null>();
  let done = 0, updatedSupa = 0, updatedAt = 0, noConfig = 0, noTemplate = 0, failed = 0;

  async function process(lead: (typeof leads)[number]) {
    const tag = lead.client_tag as string;
    if (!configCache.has(tag)) configCache.set(tag, await getConfig(tag));
    const cfg = configCache.get(tag);
    if (!cfg) { noConfig++; return; }

    const hasCC = [1, 2, 3, 4, 5, 6].some((n) => cfg[`cc_email_${n}`]);
    const hasBCC = [1, 2].some((n) => cfg[`bcc_email_${n}`]);
    if (!cfg.reply_template && !hasCC && !hasBCC) { noTemplate++; return; }

    // Resolve the reply template with the lead's variables (quoted history
    // stripped so {CONTEXT}/{COMPANY} come from the lead, not the client's sig).
    let ourReply: string | null = null;
    if (cfg.reply_template) {
      const firstName = String(lead.first_name || "").trim() || String(lead.lead_name || "").trim().split(/\s+/)[0] || "";
      ourReply = await resolveTemplate(String(cfg.reply_template), {
        firstName,
        phoneNumber: String(lead.phone || ""),
        companyName: String(lead.company_name || ""),
        senderFirstName: String(lead.sender_name || "").trim().split(/\s+/)[0] || "",
        replyBody: stripQuotedHistory(String(lead.reply_we_got || "")),
        replySubject: String(lead.email_subject || ""),
      }).catch(() => String(cfg.reply_template));
    }

    // Supabase field set (CC/BCC mirror the config; category fields untouched).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supaFields: Record<string, any> = { updated_at: new Date().toISOString() };
    if (ourReply) supaFields.our_reply = ourReply;
    for (const n of [1, 2, 3, 4, 5, 6]) {
      supaFields[`cc_name_${n}`] = cfg[`cc_name_${n}`] ? String(cfg[`cc_name_${n}`]) : null;
      supaFields[`cc_email_${n}`] = cfg[`cc_email_${n}`] ? String(cfg[`cc_email_${n}`]) : null;
    }
    for (const n of [1, 2]) {
      supaFields[`bcc_name_${n}`] = cfg[`bcc_name_${n}`] ? String(cfg[`bcc_name_${n}`]) : null;
      supaFields[`bcc_email_${n}`] = cfg[`bcc_email_${n}`] ? String(cfg[`bcc_email_${n}`]) : null;
    }

    // Airtable field set — only include fields that have a value.
    const atFields: Record<string, unknown> = {};
    if (ourReply) atFields["Our reply"] = ourReply;
    for (const n of [1, 2, 3, 4, 5, 6]) {
      if (cfg[`cc_name_${n}`]) atFields[`CC name ${n}`] = String(cfg[`cc_name_${n}`]);
      if (cfg[`cc_email_${n}`]) atFields[`CC email ${n}`] = String(cfg[`cc_email_${n}`]);
    }
    for (const n of [1, 2]) {
      if (cfg[`bcc_name_${n}`]) atFields[`BCC name ${n}`] = String(cfg[`bcc_name_${n}`]);
      if (cfg[`bcc_email_${n}`]) atFields[`BCC email ${n}`] = String(cfg[`bcc_email_${n}`]);
    }

    if (!APPLY) {
      if (done < 3) console.log(`  [preview id=${lead.id} ${tag}] our_reply=${ourReply ? `"${ourReply.slice(0, 60)}…"` : "(none)"} · CC=${[1,2,3,4,5,6].filter((n)=>cfg[`cc_email_${n}`]).length} · BCC=${[1,2].filter((n)=>cfg[`bcc_email_${n}`]).length} · airtable=${lead.airtable_record_id ? "yes" : "no"}`);
      return;
    }

    try {
      const { error: uErr } = await supabase.from("replies").update(supaFields).eq("id", lead.id);
      if (uErr) throw new Error(`supabase: ${uErr.message}`);
      updatedSupa++;
      if (Object.keys(atFields).length && lead.airtable_record_id && lead.airtable_base_id) {
        await updateRecord(String(lead.airtable_base_id), AIRTABLE_TABLE_ID, String(lead.airtable_record_id), atFields);
        updatedAt++;
      }
    } catch (e) {
      failed++;
      console.warn(`  ✗ id=${lead.id} ${tag}: ${(e as Error).message}`);
    }
  }

  // Bounded concurrency.
  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    await Promise.all(leads.slice(i, i + CONCURRENCY).map(process));
    done = Math.min(i + CONCURRENCY, leads.length);
    if (APPLY && done % 25 === 0) console.log(`  …${done}/${leads.length}`);
  }

  console.log(`\nDone. supabase updated: ${updatedSupa} · airtable updated: ${updatedAt} · no config: ${noConfig} · no template/CC/BCC: ${noTemplate} · failed: ${failed}`);
  if (!APPLY) console.log("\n(dry run — re-run with --apply to write)");
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
