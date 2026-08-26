import { syncOneClient } from "@/lib/nurture/sync-sequence-finished";
import { getAllClientInstances } from "@/lib/nurture/group-routing";
import { getChurnedTags } from "@/lib/churn";
import supabase from "@/lib/supabase";

async function total(tag: string): Promise<number> {
  const { count } = await supabase.from("nurture_sequence_finished").select("*", { count: "exact", head: true }).eq("client_tag", tag);
  return count ?? 0;
}

async function drainClient(tag: string, b2b: string, b2c: string, group: number) {
  const instances = [...new Set([b2b, b2c])];
  const start = await total(tag);
  let running = start;
  for (let pass = 1; pass <= 25; pass++) {
    let found = 0, up = 0;
    for (const i of instances) {
      try { const r = await syncOneClient(i as any, tag, { maxMs: 90_000 }); found += r.candidatesFound; up += r.upserted; }
      catch (e) { console.log(`    ${tag} @${i} pass ${pass}: ERR ${(e as Error).message}`); }
    }
    running = await total(tag);
    if (found === 0) { console.log(`  ${tag} (G${group}) DONE after ${pass} pass(es): ${start} -> ${running}`); return { tag, start, end: running }; }
    console.log(`  ${tag} (G${group}) pass ${pass}: found=${found} up=${up} total=${running}`);
  }
  console.log(`  ${tag} (G${group}) hit 25-pass cap: ${start} -> ${running} (cron will finish)`);
  return { tag, start, end: running };
}

async function main() {
  const all = await getAllClientInstances();
  const churned = await getChurnedTags();
  const tags: { tag: string; b2b: string; b2c: string; group: number; have: number }[] = [];
  for (const [tag, inst] of all) {
    if (churned.has(tag.toUpperCase())) continue;
    tags.push({ tag, b2b: inst.b2b, b2c: inst.b2c, group: inst.group, have: await total(tag) });
  }
  // Least-covered first so the most-lacking clients fill first.
  tags.sort((a, b) => a.have - b.have);
  console.log(`FLEET DRAIN: ${tags.length} active clients, least-covered first.\n`);
  const results: { tag: string; start: number; end: number }[] = [];
  for (const t of tags) results.push(await drainClient(t.tag, t.b2b, t.b2c, t.group));
  const gained = results.reduce((s, r) => s + (r.end - r.start), 0);
  console.log(`\n=== FLEET DRAIN COMPLETE ===`);
  console.log(`total new sequence-finished leads added: ${gained.toLocaleString()}`);
  const biggest = results.map(r => ({ ...r, d: r.end - r.start })).sort((a, b) => b.d - a.d).slice(0, 20);
  console.log("biggest gains:");
  for (const r of biggest) console.log(`  ${r.tag}: +${r.d} (${r.start} -> ${r.end})`);
  console.log("ALL DONE.");
}
main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
