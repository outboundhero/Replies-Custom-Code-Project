import { syncOneClient } from "@/lib/nurture/sync-sequence-finished";
import { getClientInstances } from "@/lib/nurture/group-routing";
import supabase from "@/lib/supabase";

async function total(tag: string): Promise<number> {
  const { count } = await supabase.from("nurture_sequence_finished").select("*", { count: "exact", head: true }).eq("client_tag", tag);
  return count ?? 0;
}

async function probe(tag: string) {
  const inst = await getClientInstances(tag);
  if (!inst) { console.log(`  ${tag}: NO GROUP MAPPING`); return; }
  const instances = [...new Set([inst.b2b, inst.b2c])];
  let found = 0, up = 0;
  for (const i of instances) {
    try { const r = await syncOneClient(i, tag, { maxMs: 25_000 }); found += r.candidatesFound; up += r.upserted; }
    catch (e) { console.log(`  ${tag} @${i}: ERR ${(e as Error).message}`); }
  }
  console.log(`  ${tag} (G${inst.group}, ${instances.join("+")}): found=${found} upserted=${up} total=${await total(tag)}`);
}

async function main() {
  const sample = ["AGCS", "K&LCS", "JPLA", "JPNA", "GJS", "PC", "CCHS", "CWSJ-OS", "SI"];
  console.log("=== PROBE (1 short pass each — does a backlog appear?) ===");
  for (const t of sample) await probe(t);
  console.log("DONE");
}
main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
