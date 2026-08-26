import { sweepCampaignLeadsCursor, attachLeadsToCampaign, removeLeadsFromCampaign, getCampaignLeadCount } from "@/lib/outboundhero-api";
const INSTANCE = "facilityreach";
const TRIOS: [string, number, number[]][] = [
  ["google", 151, [265, 334]],
  ["outlook", 152, [266, 335]],
  ["segs",   153, [267, 336]],
];
async function sweepAll(campaignId: number): Promise<number[]> {
  const ids: number[] = []; let cursor: string | null = null;
  for (let i = 0; i < 80; i++) {
    const r = await sweepCampaignLeadsCursor(INSTANCE, campaignId, cursor, { maxLeads: 5000, maxMs: 150000 });
    for (const l of r.leads) if (typeof l.id === "number") ids.push(l.id);
    if (r.done) break; cursor = r.nextCursor; if (!cursor) break;
  }
  return [...new Set(ids)];
}
async function main() {
  console.log("=== JPC&A nurture merge → Batch 1 (facilityreach) ===");
  for (const [esp, b1, srcs] of TRIOS) {
    console.log(`\n--- ${esp} → Batch 1 #${b1} ---`);
    const all: number[] = [];
    for (const s of srcs) { const ids = await sweepAll(s); console.log(`  swept #${s}: ${ids.length}`); all.push(...ids); }
    const uniq = [...new Set(all)];
    if (!uniq.length) { console.log("  nothing to move."); continue; }
    const att = await attachLeadsToCampaign(INSTANCE, b1, uniq, true);
    console.log(`  attach → #${b1}: ok=${att.ok} attached=${att.attachedCount}/${att.requestedCount}${att.error?` err=${att.error}`:""}`);
    if (!att.ok) { console.log("  ⚠️ attach failed — leaving sources intact."); continue; }
    for (const s of srcs) {
      const idsForSrc = await sweepAll(s);
      if (!idsForSrc.length) { console.log(`  #${s}: already empty`); continue; }
      const rem = await removeLeadsFromCampaign(INSTANCE, s, idsForSrc);
      console.log(`  remove ← #${s}: ok=${rem.ok} removed=${rem.removedCount}/${rem.requestedCount}${rem.error?` err=${rem.error}`:""}`);
    }
  }
  console.log("\nAFTER:");
  const camps: [string,number][] = [["B1 google",151],["B1 outlook",152],["B1 segs",153],["B2 google",265],["B2 outlook",266],["B2 segs",267],["B3 google",334],["B3 outlook",335],["B3 segs",336]];
  for (const [l,id] of camps) console.log(`  ${l.padEnd(11)} #${id}: ${await getCampaignLeadCount(INSTANCE, id)}`);
  console.log("=== MERGE COMPLETE ===");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
