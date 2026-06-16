/**
 * Resume the exact campaigns we attached leads to, read straight from the
 * auto-route logs (campaign id + name + attached count). No extra lookups.
 *   npx tsx scripts/_resume.ts            # PLAN (print, no resume)
 *   npx tsx scripts/_resume.ts --resume   # PATCH /resume each + report
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync } from "fs";

const RESUME = process.argv.includes("--resume");

async function main() {
  const { resumeCampaign } = await import("../lib/outboundhero-api");
  // Parse: TAG/ESP -> "NAME" (id N): attached M/T
  const re = /-> "([^"]+)" \(id (\d+)\): attached (\d+)\//g;
  const camps = new Map<number, { name: string; leads: number }>();
  for (const f of ["/tmp/autoroute_pass1.txt", "/tmp/autoroute.txt"]) {
    let txt = ""; try { txt = readFileSync(f, "utf8"); } catch { /* ok */ }
    for (const m of txt.matchAll(re)) {
      const name = m[1], id = Number(m[2]), attached = Number(m[3]);
      if (attached <= 0) continue;
      const cur = camps.get(id);
      camps.set(id, { name, leads: (cur?.leads || 0) + attached });
    }
  }
  const rows = [...camps.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.leads - a.leads);

  let total = 0, ok = 0, fail = 0;
  console.log(`\n${RESUME ? "RESUMING" : "PLAN —"} ${rows.length} campaigns:\n`);
  for (const r of rows) {
    let res = "";
    if (RESUME) {
      const rr = await resumeCampaign("outboundhero", r.id);
      if (rr.ok) { res = "✓ RESUMED"; ok++; } else { res = `✗ FAIL ${rr.status}: ${(rr.error || "").slice(0, 60)}`; fail++; }
    }
    const name = r.name.replace(" [Nurture] (Cleaning Client)", "");
    console.log(`  ${name.padEnd(20)} id=${String(r.id).padEnd(6)} leads=${String(r.leads).padEnd(7)} ${res}`);
    total += r.leads;
  }
  console.log(`\nTotal: ${rows.length} campaigns, ${total.toLocaleString()} leads${RESUME ? ` — resumed ${ok}, failed ${fail}` : ""}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
