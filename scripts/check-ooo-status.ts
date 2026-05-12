import { config } from "dotenv";
import supabase from "../lib/supabase";

config({ path: ".env.local" });

async function main() {
  const nowIso = new Date().toISOString();

  // OOO rows by status
  const { count: scheduledTotal } = await supabase
    .from("replies")
    .select("id", { count: "exact", head: true })
    .eq("auto_reply_kind", "out_of_office");

  const { count: pending } = await supabase
    .from("replies")
    .select("id", { count: "exact", head: true })
    .eq("auto_reply_kind", "out_of_office")
    .is("auto_reply_sent_at", null);

  const { count: sent } = await supabase
    .from("replies")
    .select("id", { count: "exact", head: true })
    .eq("auto_reply_kind", "out_of_office")
    .not("auto_reply_sent_at", "is", null);

  const { count: dueNow } = await supabase
    .from("replies")
    .select("id", { count: "exact", head: true })
    .eq("auto_reply_kind", "out_of_office")
    .is("auto_reply_sent_at", null)
    .lte("auto_reply_due_at", nowIso);

  console.log("Out Of Office auto-reply status\n");
  console.log(`  Total rows scheduled (kind='out_of_office'): ${scheduledTotal ?? 0}`);
  console.log(`    Pending (sent_at is NULL):                 ${pending ?? 0}`);
  console.log(`    Already sent:                              ${sent ?? 0}`);
  console.log(`    Due NOW (cron-eligible):                   ${dueNow ?? 0}`);
  console.log("");

  // Soonest 5 upcoming
  const { data: upcoming } = await supabase
    .from("replies")
    .select("id, lead_email, auto_reply_due_at")
    .eq("auto_reply_kind", "out_of_office")
    .is("auto_reply_sent_at", null)
    .gt("auto_reply_due_at", nowIso)
    .order("auto_reply_due_at", { ascending: true })
    .limit(5);
  console.log("Next 5 firing:");
  for (const r of upcoming || []) {
    console.log(`  · ${r.auto_reply_due_at}  →  ${r.lead_email}`);
  }
  console.log("");

  // Most-recent 5 sent
  const { data: sentRows } = await supabase
    .from("replies")
    .select("id, lead_email, auto_reply_due_at, auto_reply_sent_at, sent_reply")
    .eq("auto_reply_kind", "out_of_office")
    .not("auto_reply_sent_at", "is", null)
    .order("auto_reply_sent_at", { ascending: false })
    .limit(5);
  console.log("Last 5 sent:");
  for (const r of sentRows || []) {
    const summary = (r.sent_reply || "").toString().slice(0, 80).replace(/\n/g, " ⏎ ");
    console.log(`  [${r.id}] sent ${r.auto_reply_sent_at}  →  ${r.lead_email}`);
    console.log(`     due_at: ${r.auto_reply_due_at}`);
    console.log(`     body:   ${summary}…`);
  }
  if (!sentRows?.length) console.log("  (none yet)");
}

main();
