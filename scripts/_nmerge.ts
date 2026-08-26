import db from "@/lib/db";
import { getInstanceConfig } from "@/lib/bison-instances";
import { sweepCampaignLeadsCursor, attachLeadsToCampaign, removeLeadsFromCampaign, resumeCampaign, pauseCampaign, getCampaignLeadCount } from "@/lib/outboundhero-api";
import { isFired } from "@/lib/nurture/activation-state";

async function sweepAll(inst: string, cid: number): Promise<number[]> {
  const ids: number[] = []; let cursor: string | null = null;
  for (let i=0;i<80;i++){ const r = await sweepCampaignLeadsCursor(inst, cid, cursor, { maxLeads:5000, maxMs:150000 }); for (const l of r.leads) if (typeof l.id==="number") ids.push(l.id); if (r.done) break; cursor=r.nextCursor; if(!cursor) break; }
  return [...new Set(ids)];
}
async function deleteCampaign(inst: string, id: number){
  const { baseUrl, token } = getInstanceConfig(inst);
  const res = await fetch(`${baseUrl}/api/campaigns/${id}`, { method:"DELETE", headers:{ Authorization:`Bearer ${token}`, Accept:"application/json" }});
  return res.status;
}

async function main(){
  const all = await db.execute("SELECT client_tag, bison_instance, esp, batch, old_campaign_id, new_campaign_id FROM nurture_campaign_expansions");
  const maxByClient = new Map<string, number>();
  for (const r of all.rows){ const t=String(r.client_tag).toUpperCase(); maxByClient.set(t, Math.max(maxByClient.get(t)||0, Number(r.batch))); }
  const clients = [...maxByClient.entries()].filter(([,b])=>b>=3).map(([t])=>t);
  console.log(`Merging ${clients.length} batch-3+ clients: ${clients.join(", ")}\n`);

  for (const tag of clients){
    const rows = all.rows.filter(r=>String(r.client_tag).toUpperCase()===tag);
    const byKey = new Map<string, {batch1:number|null, clones:number[]}>();
    for (const r of rows){ const key=`${r.bison_instance}|${r.esp}`; const e=byKey.get(key)||{batch1:null,clones:[]}; if(Number(r.batch)===2) e.batch1=Number(r.old_campaign_id); e.clones.push(Number(r.new_campaign_id)); byKey.set(key,e); }
    const fired = await isFired(tag);
    console.log(`=== ${tag} (fired=${fired}) ===`);
    for (const [key,e] of byKey){
      const [inst,esp] = key.split("|");
      if (!e.batch1){ console.log(`  ${esp}: no batch1 resolved, skip`); continue; }
      // merge each clone into batch1
      for (const clone of e.clones){
        const ids = await sweepAll(inst, clone);
        if (ids.length){
          let ok=false; for(let t=0;t<4&&!ok;t++){ const a=await attachLeadsToCampaign(inst, e.batch1, ids, true); if(a.ok){ok=true;} else await new Promise(r=>setTimeout(r,3000)); }
          if (ok){ await removeLeadsFromCampaign(inst, clone, await sweepAll(inst, clone)); }
          else { console.log(`  ${esp} clone #${clone}: attach failed, leaving intact`); continue; }
        }
        const st = await deleteCampaign(inst, clone);
        console.log(`  ${esp}: clone #${clone} (${ids.length} leads → Batch1 #${e.batch1}) deleted[${st}]`);
      }
      // re-point map to batch1
      await db.execute({ sql:"UPDATE nurture_campaign_map SET campaign_id=?, updated_at=datetime('now') WHERE UPPER(client_tag)=UPPER(?) AND bison_instance=? AND esp=?", args:[e.batch1, tag, inst, esp] });
      // active/paused per trigger: fired → active batch1, else paused
      try { if (fired) await resumeCampaign(inst, e.batch1); else await pauseCampaign(inst, e.batch1); } catch {}
      const cnt = await getCampaignLeadCount(inst, e.batch1);
      console.log(`  ${esp}: Batch1 #${e.batch1} now ${cnt} leads, ${fired?"ACTIVE":"PAUSED"}, map re-pointed`);
    }
    await db.execute({ sql:"DELETE FROM nurture_campaign_expansions WHERE UPPER(client_tag)=UPPER(?)", args:[tag] });
  }

  // CCGLA leftover empty batch2 campaigns (facilityreach)
  console.log(`\n=== CCGLA empty Batch2 cleanup ===`);
  for (const id of [256,257,258]){ const st = await deleteCampaign("facilityreach", id); console.log(`  deleted #${id} [${st}]`); }
  await db.execute("DELETE FROM nurture_campaign_expansions WHERE UPPER(client_tag)='CCGLA'");
  console.log("\n=== MERGE COMPLETE ===");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
