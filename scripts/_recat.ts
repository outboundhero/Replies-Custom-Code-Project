import supabase from "@/lib/supabase";
import { categorizeReply } from "@/lib/processing/lead-categorizer";
function fridayMorningPT(): string {
  let d = new Date();
  for (let i=0;i<8;i++){ const wd = new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",weekday:"short"}).format(d); if (wd==="Fri") break; d = new Date(d.getTime()-86400000); }
  const p = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(d);
  const y=p.find(x=>x.type==="year")!.value, m=p.find(x=>x.type==="month")!.value, day=p.find(x=>x.type==="day")!.value;
  return new Date(`${y}-${m}-${day}T09:00:00-07:00`).toISOString();
}
async function main(){
  const cutoff = fridayMorningPT();
  console.log(`Cutoff (Friday ~9am PT): ${cutoff}`);
  const { data } = await supabase.from("replies")
    .select("id, from_email, prospect_cc_email, email_subject, reply_we_got, lead_email")
    .eq("ai_categorized_lead_category","Referral Given").gte("reply_time", cutoff).order("id");
  const rows = data || [];
  console.log(`Referral Given leads since cutoff: ${rows.length}`);
  const transitions: Record<string,number> = {}; let changed=0, unchanged=0, errored=0; const samples:string[]=[];
  const CONC=6;
  for (let i=0;i<rows.length;i+=CONC){
    const batch = rows.slice(i,i+CONC);
    await Promise.all(batch.map(async (r)=>{
      let neu="Referral Given";
      try { neu = await categorizeReply(String(r.from_email||""),String(r.prospect_cc_email||""),String(r.email_subject||""),String(r.reply_we_got||"")); } catch { errored++; return; }
      if (neu==="Referral Given"){ unchanged++; return; }
      transitions[neu]=(transitions[neu]||0)+1; changed++;
      await supabase.from("replies").update({ ai_categorized_lead_category: neu }).eq("id", r.id);
      if (samples.length<15) samples.push(`  #${r.id} ${r.lead_email} → ${neu}  ["${String(r.email_subject||"").slice(0,45)}"]`);
    }));
    if ((i+CONC)%60===0) console.log(`  ...processed ${Math.min(i+CONC,rows.length)}/${rows.length}`);
  }
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total: ${rows.length} | re-classified OUT of Referral Given: ${changed} | still Referral Given: ${unchanged} | errors: ${errored}`);
  console.log(`New categories: ${JSON.stringify(transitions)}`);
  console.log(`Samples:\n${samples.join("\n")}`);
  console.log("=== DONE ===");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
