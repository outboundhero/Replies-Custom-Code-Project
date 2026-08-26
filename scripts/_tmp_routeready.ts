import { config } from "dotenv"; config({ path: ".env.local" });
import { runAutoPushForClient } from "@/lib/nurture/auto-push";
const TAGS = ["JPET","RFS","IJSD","JPCI","DM4PM","JPC","CI","SFS","JPNNJ","CWSJ","BBS","FSD","ABM","BAJFI"]; // smallest-ready-ish first
(async()=>{
  let grand=0;
  for(const TAG of TAGS){
    let seqAfter=0,repAfter=0,legAfter=0,total=0,rounds=0;
    const t0=Date.now();
    console.log(`\n══ ${TAG} ══ routing ready…`);
    for(;;){
      let r;
      try { r = await runAutoPushForClient(TAG,{cap:5000,seqAfterId:seqAfter,repAfterId:repAfter,legAfterId:legAfter}); }
      catch(e){ console.log(`  ⚠ ${TAG} round ${rounds+1} error: ${(e as Error).message} — stopping client`); break; }
      total+=r.totalAttached; seqAfter=r.nextSeqAfterId; repAfter=r.nextRepAfterId; legAfter=r.nextLegAfterId; rounds++;
      console.log(`  ${TAG} round ${rounds}: +${r.totalAttached} (total ${total})${r.exhausted?" · drained":""}`);
      if(r.exhausted||rounds>1000) break;
    }
    grand+=total;
    console.log(`✅ ${TAG}: routed ${total.toLocaleString()} ready leads in ${Math.round((Date.now()-t0)/1000)}s`);
  }
  console.log(`\n✅ Phase B complete — routed ${grand.toLocaleString()} ready leads across ${TAGS.length} clients.`);
})().then(()=>process.exit(0)).catch(e=>{console.error("FATAL",e);process.exit(1)});
