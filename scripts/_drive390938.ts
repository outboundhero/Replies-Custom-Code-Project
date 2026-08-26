import db from "@/lib/db";
import { findSenderEmailByAddress } from "@/lib/outboundhero-api";
import { processSendRetries } from "@/lib/send-retry";
const EMAIL = "aubrey.o@reliablejanitorial.co", INSTANCE = "outboundhero", RID = 390938;
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));
async function main(){
  for (let i=0;i<40;i++){ // ~20 min @30s
    const live = await findSenderEmailByAddress(INSTANCE, EMAIL).catch(()=>null);
    if (live && live.id){
      console.log(`[t+${i*30}s] inbox BACK: id=${live.id} status=${live.status} — driving the resend now`);
      await db.execute({ sql:"UPDATE send_reply_retries SET next_attempt_at=? WHERE reply_row_id=? AND status='pending'", args:[new Date().toISOString(), RID] });
      const res = await processSendRetries();
      console.log("processSendRetries →", JSON.stringify(res));
      const chk = await db.execute({ sql:"SELECT status,last_error FROM send_reply_retries WHERE reply_row_id=? ORDER BY id DESC LIMIT 1", args:[RID] });
      const rep = (await import("@/lib/supabase")).default;
      const { data } = await rep.from("replies").select("send_error,last_sent_at").eq("id",RID).single();
      console.log("retry row →", JSON.stringify(chk.rows[0]), "| reply →", JSON.stringify(data));
      console.log(data && !data.send_error ? "✅ SENT — error cleared" : "⚠️ still not sent — see above");
      return;
    }
    console.log(`[t+${i*30}s] inbox not back yet — waiting`);
    await sleep(30000);
  }
  console.log("Timed out ~20min — inbox still reconnecting; the auto-retry cron will resend once it lands.");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
