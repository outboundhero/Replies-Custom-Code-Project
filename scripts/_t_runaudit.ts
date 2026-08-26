import supabase from "@/lib/supabase";
import { qualifyLead } from "@/lib/qualification/qualify-lead";
const AIRTABLE_TABLE_ID = "tbl1BnpnsUBrBGeuy";
const CATS = ["Interested","Meeting Request","Referral Given","Internally Forwarded"];
(async () => {
  const { data: rows } = await supabase.from("replies")
    .select("id, client_tag, company_name, city, state, address, google_maps_url, phone, lead_email, from_email, reply_we_got, email_subject, airtable_record_id, airtable_base_id, bison_instance, ai_categorized_lead_category, audit_city, audit_state, audit_industry")
    .in("ai_categorized_lead_category", CATS).not("airtable_record_id","is",null).not("airtable_base_id","is",null)
    .is("industry_audit",null).neq("client_tag","N/A").not("client_tag","is",null)
    .order("reply_time",{ascending:false}).limit(6);
  console.log("pending to audit:", rows?.length);
  for (const r of rows||[]) {
    try {
      await qualifyLead({ campaignTag:r.client_tag, companyName:r.company_name||"", city:r.city||"", state:r.state||"", address:r.address||"", googleMapsUrl:r.google_maps_url||"", phone:String(r.phone||""), linkedin:"", leadEmail:r.lead_email||r.from_email||"", replyText:r.reply_we_got||"", replySubject:r.email_subject||"", recordId:r.airtable_record_id, airtableBaseId:r.airtable_base_id, airtableTableId:AIRTABLE_TABLE_ID, bisonInstance:r.bison_instance||undefined });
      // read back
      const { data: a } = await supabase.from("replies").select("industry_audit, location_audit, suggested_client, audit_city, audit_state, audit_industry").eq("id",r.id).single();
      console.log(`  #${r.id} ${r.ai_categorized_lead_category} -> industry=${a?.industry_audit} location=${a?.location_audit} city=${a?.audit_city} state=${a?.audit_state} ind=${(a?.audit_industry||"").slice(0,20)}`);
    } catch(e){ console.log(`  #${r.id} FAILED:`, (e as Error).message); }
  }
})().catch(e=>console.error("THREW:",e));
