import { syncOneClient } from "@/lib/nurture/sync-sequence-finished";
import supabase from "@/lib/supabase";
import db from "@/lib/db";
const cnt = async (camp:number) => (await supabase.from("nurture_sequence_finished").select("id",{count:"exact",head:true}).eq("client_tag","JPOKC").eq("ob_campaign_id",camp)).count;
(async () => {
  for (let i=1;i<=5;i++){
    const r = await syncOneClient("outboundhero","JPOKC",{ maxMs: 90_000 });
    const cur = await db.execute("SELECT campaign_id, completed_at FROM nurture_sync_cursor WHERE bison_instance='outboundhero' AND campaign_id IN (929,930)");
    const done = (cur.rows as any[]).filter(x=>x.completed_at).map(x=>x.campaign_id);
    console.log(`run ${i}: upserted=${r.upserted} | camp929=${await cnt(929)} camp930=${await cnt(930)} | completed=[${done.join(",")}]`);
    if (done.includes(929) && done.includes(930)) { console.log("BOTH campaigns fully drained ✓"); break; }
  }
})().catch(e=>console.error("THREW:",e));
