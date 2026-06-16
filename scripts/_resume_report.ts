/**
 * Resume + report for the nurture campaigns we attached leads to.
 *   npx tsx scripts/_resume_report.ts            # PLAN only (no resume)
 *   npx tsx scripts/_resume_report.ts --resume   # PATCH /resume each, then report
 *
 * Campaign set is derived from the auto-route logs (every campaign that got
 * attached > 0), cross-checked with a live lead count from the DB.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync } from "fs";
import supabase from "../lib/supabase";

const RESUME = process.argv.includes("--resume");

function pad(s: string | number, n: number) { return String(s).padEnd(n); }

async function main() {
  const { listCampaigns, resumeCampaign } = await import("../lib/outboundhero-api");

  // Campaign IDs we attached leads to (from both auto-route passes).
  const logs = ["/tmp/autoroute_pass1.txt", "/tmp/autoroute.txt"];
  const ids = new Set<number>();
  for (const f of logs) {
    let txt = ""; try { txt = readFileSync(f, "utf8"); } catch { /* missing log ok */ }
    for (const m of txt.matchAll(/\(id (\d+)\): attached (\d+)\//g)) {
      if (Number(m[2]) > 0) ids.add(Number(m[1]));
    }
  }

  const camps = await listCampaigns("outboundhero", { statuses: ["draft", "active", "paused", "archived", "completed"] });
  const map = new Map<number, any>(); for (const c of camps) map.set(c.id, c);

  const rows: Array<{ id: number; name: string; status: string; leads: number }> = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const { count: seqC } = await supabase.from("nurture_sequence_finished").select("id", { count: "exact", head: true }).eq("nurture_campaign_id", id);
    const { count: repC } = await supabase.from("replies").select("id", { count: "exact", head: true }).eq("nurture_campaign_id", id);
    const c = map.get(id);
    rows.push({ id, name: c?.name || `(campaign ${id})`, status: c?.status || "?", leads: (seqC || 0) + (repC || 0) });
  }
  rows.sort((a, b) => b.leads - a.leads);

  console.log(`\n${pad("CAMPAIGN", 46)} ${pad("WAS", 9)} ${pad(RESUME ? "RESULT" : "LEADS", 12)} ${RESUME ? "LEADS" : ""}`);
  console.log("-".repeat(80));
  let totalLeads = 0, ok = 0, fail = 0;
  for (const r of rows) {
    let result = "";
    if (RESUME) {
      const rr = await resumeCampaign("outboundhero", r.id);
      if (rr.ok) { result = "RESUMED ✓"; ok++; } else { result = `FAIL ${rr.status}`; fail++; }
    }
    const name = r.name.replace(" (Cleaning Client)", "").replace(" [Nurture]", "");
    console.log(`${pad(name.slice(0, 44), 46)} ${pad(r.status, 9)} ${RESUME ? pad(result, 12) + r.leads : r.leads}`);
    totalLeads += r.leads;
  }
  console.log("-".repeat(80));
  console.log(`${rows.length} campaigns · ${totalLeads.toLocaleString()} leads${RESUME ? ` · resumed ${ok}, failed ${fail}` : " to activate"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
