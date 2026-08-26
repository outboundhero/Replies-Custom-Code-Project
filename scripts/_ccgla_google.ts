import { sweepCampaignLeadsCursor, attachLeadsToCampaign, removeLeadsFromCampaign, getCampaignLeadCount } from "@/lib/outboundhero-api";
const INSTANCE = "facilityreach";
async function sweepAll(cid: number): Promise<number[]> {
  const ids: number[] = []; let cursor: string | null = null;
  for (let i=0;i<80;i++){ const r = await sweepCampaignLeadsCursor(INSTANCE, cid, cursor, { maxLeads:5000, maxMs:150000 }); for (const l of r.leads) if (typeof l.id==="number") ids.push(l.id); if (r.done) break; cursor=r.nextCursor; if(!cursor) break; }
  return [...new Set(ids)];
}
async function main(){
  const B1=148, SRC=256;
  console.log("=== CCGLA google merge #256 → #148 (retry) ===");
  const ids = await sweepAll(SRC); console.log(`swept #${SRC}: ${ids.length}`);
  if (!ids.length){ console.log("already empty"); }
  else {
    // attach in smaller chunks by calling repeatedly (attachLeadsToCampaign chunks at 1000; retry the call up to 3x for 504s)
    let attached=false;
    for (let t=0;t<4 && !attached;t++){ const att = await attachLeadsToCampaign(INSTANCE, B1, ids, true); console.log(`  attach try${t+1} → ok=${att.ok} attached=${att.attachedCount}/${att.requestedCount}${att.error?` err=${att.error}`:""}`); if (att.ok){ attached=true; } else { await new Promise(r=>setTimeout(r,3000)); } }
    if (attached){ const rem = await removeLeadsFromCampaign(INSTANCE, SRC, await sweepAll(SRC)); console.log(`  remove ← #${SRC}: ok=${rem.ok} removed=${rem.removedCount}/${rem.requestedCount}${rem.error?` err=${rem.error}`:""}`); }
    else console.log("  ⚠️ attach still failing — left intact.");
  }
  console.log(`\nAFTER: #148=${await getCampaignLeadCount(INSTANCE,148)}  #256=${await getCampaignLeadCount(INSTANCE,256)}`);
  console.log("=== DONE ===");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
