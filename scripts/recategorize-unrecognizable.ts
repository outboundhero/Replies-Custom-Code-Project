/**
 * Re-categorize replies that were wrongly tagged "Unrecognizable by AI" while
 * the OpenAI quota was exhausted. Re-runs the categorizer over each reply's
 * actual content and writes the corrected category back to BOTH Supabase
 * Updates ONLY the AI-suggested category: replies.ai_categorized_lead_category
 * (Supabase) + "AI Categorized Lead Category" (Airtable). Leaves the operator's
 * working `lead_category` / "Lead Category" untouched.
 *
 *   --dry            preview only (no writes); also prints an hourly histogram
 *   --since <iso>    only replies with reply_time >= this (default: start of today UTC)
 *   --until <iso>    only replies with reply_time <  this (default: none — open-ended)
 *   --concurrency N  parallel OpenAI calls (default 5)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import supabase from "../lib/supabase";
import { categorizeReply } from "../lib/processing/lead-categorizer";
import { updateRecord } from "../lib/airtable";

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const CONC = (() => { const i = args.indexOf("--concurrency"); return i >= 0 ? Math.max(1, Number(args[i + 1]) || 5) : 5; })();
const SINCE = (() => {
  const i = args.indexOf("--since");
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0)).toISOString();
})();
const UNTIL = (() => { const i = args.indexOf("--until"); return i >= 0 && args[i + 1] ? args[i + 1] : null; })();

interface Row {
  id: number; from_email: string | null; prospect_cc_email: string | null;
  email_subject: string | null; reply_we_got: string | null; reply_time: string | null;
  airtable_record_id: string | null; airtable_base_id: string | null; section_name: string | null;
}

async function main() {
  console.log(`Re-categorize "Unrecognizable by AI" since ${SINCE}${UNTIL ? ` until ${UNTIL}` : ""} ${DRY ? "(DRY RUN)" : "(LIVE)"}`);

  // Pull affected replies (paginate).
  const rows: Row[] = [];
  let start = 0;
  for (;;) {
    let q = supabase.from("replies")
      .select("id, from_email, prospect_cc_email, email_subject, reply_we_got, reply_time, airtable_record_id, airtable_base_id, section_name")
      .eq("ai_categorized_lead_category", "Unrecognizable by AI")
      .gte("reply_time", SINCE);
    if (UNTIL) q = q.lt("reply_time", UNTIL);
    const { data, error } = await q
      .order("reply_time", { ascending: true })
      .range(start, start + 999);
    if (error) { console.log("fetch err:", error.message); return; }
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < 1000) break; start += 1000;
  }
  console.log(`Found ${rows.length} replies tagged "Unrecognizable by AI" since ${SINCE}`);

  // Hourly histogram (helps confirm the outage window).
  const byHour = new Map<string, number>();
  for (const r of rows) { const h = (r.reply_time || "").slice(0, 13); byHour.set(h, (byHour.get(h) || 0) + 1); }
  console.log("Hourly volume (UTC):");
  for (const [h, n] of [...byHour.entries()].sort()) console.log(`  ${h}:00  ${"█".repeat(Math.min(60, n))} ${n}`);

  if (DRY) { console.log("\n(dry run — no changes written)"); return; }

  // Section name -> { base_id, table_id } for the Airtable write-back.
  const { default: db } = await import("../lib/db");
  const secRows = (await db.execute("SELECT name, airtable_base_id, airtable_table_id FROM sections")).rows as any[];
  const secByName = new Map<string, { base: string; table: string }>();
  for (const s of secRows) if (s.name && s.airtable_base_id && s.airtable_table_id) secByName.set(String(s.name), { base: String(s.airtable_base_id), table: String(s.airtable_table_id) });

  let changed = 0, unchanged = 0, errs = 0;
  const tally: Record<string, number> = {};
  let idx = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (idx < rows.length) {
      const r = rows[idx++];
      try {
        const cat = await categorizeReply(r.from_email || "", r.prospect_cc_email || "", r.email_subject || "", r.reply_we_got || "");
        if (cat === "Unrecognizable by AI") { unchanged++; continue; }
        // write Supabase
        await supabase.from("replies").update({ ai_categorized_lead_category: cat }).eq("id", r.id);
        // write Airtable (best-effort)
        const sec = r.section_name ? secByName.get(r.section_name) : null;
        const base = sec?.base || r.airtable_base_id || null;
        if (r.airtable_record_id && base && sec?.table) {
          try { await updateRecord(base, sec.table, r.airtable_record_id, { "AI Categorized Lead Category": cat }); }
          catch (e) { console.log(`  airtable update failed id=${r.id}: ${(e as Error).message}`); }
        }
        changed++; tally[cat] = (tally[cat] || 0) + 1;
        if (changed % 25 === 0) console.log(`  …${changed} re-categorized`);
      } catch (e) { errs++; console.log(`  err id=${r.id}: ${(e as Error).message}`); }
    }
  }));

  console.log(`\nDONE: re-categorized=${changed} still-unrecognizable=${unchanged} errors=${errs}`);
  console.log("New categories:", JSON.stringify(tally, null, 0));
}
main().then(() => process.exit(0)).catch((e) => { console.log("FATAL", e.message); process.exit(1); });
