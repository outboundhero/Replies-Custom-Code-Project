/**
 * Bulk auto-route: attach esp-CONFIRMED Ready leads (seq + replies) into each
 * client's canonical "[Nurture] (Cleaning Client)" campaigns, by ESP bucket.
 * Does NOT resume campaigns (no emails sent) — that's a separate step.
 *
 *   npx tsx scripts/_autoroute.ts --dry           # preview only, no writes
 *   npx tsx scripts/_autoroute.ts                 # attach for real
 *   npx tsx scripts/_autoroute.ts --client TGS    # scope to one client
 *
 * Only esp-confirmed leads are routed (esp NOT NULL) — null-esp leads are held
 * back so custom-domain Outlook/SEG mailboxes never land in the Google campaign.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { appendFileSync } from "fs";
import supabase from "../lib/supabase";
import { effectiveEsp, isCanonicalNurtureCampaign, detectCampaignEsp, ESP_LABEL, type Esp } from "../lib/nurture/esp";
import { extractTagFromCampaignName } from "../lib/processing/tag-resolver";

const RESULTS = "/tmp/autoroute.txt";
const NURTURE_DAYS = 45;
const args = process.argv.slice(2);
// Bison's attach is all-or-nothing per batch: one bounced/unsub/in-sequence
// lead rejects the whole batch. Default 100 for the first pass; a salvage pass
// uses a small --batch N so only the truly-bad leads fail (not batch-mates).
const ATTACH_BATCH = (() => { const i = args.indexOf("--batch"); return i >= 0 ? Math.max(1, Number(args[i + 1]) || 100) : 100; })();
const DRY = args.includes("--dry");
const ONLY = (() => { const i = args.indexOf("--client"); return i >= 0 ? args[i + 1]?.toUpperCase().split(",") : null; })();

const ALL = ["SBCC","JPWM","JPC&A","JPH","JPNNJ","JPNW","BAJFI","RFS","GJEC","TGS","MS","JPNH","JPET","JPETC","ICCCS","JPTUC","JPKC","JPK","CCGSWI","JPPH","ESJ"];
const CLIENTS = ONLY ? ONLY : ALL;
const EXCL = ["Interested","Meeting Request","Meeting Set","Do Not Contact","Wrong Person","Wrong Person (Change of Target)","Not Interested","Mailbox No Longer Active","Automated Error Message","Automated Catch-All Message","Referral Given","Internally Forwarded"];

function log(s: string) { const l = `${new Date().toISOString().slice(11,19)} ${s}`; console.log(l); appendFileSync(RESULTS, l + "\n"); }

let _list: any, _resolve: any, _attach: any, _find: any;
async function load() {
  const api = await import("../lib/outboundhero-api");
  const bi = await import("../lib/bison-instances");
  _list = api.listCampaigns; _attach = api.attachLeadsToCampaign; _find = api.findLeadByEmail; _resolve = bi.resolveInstanceForClient;
}

interface Lead { source: "seq" | "reply"; rowId: number; obLeadId: number | null; email: string; esp: Esp }

async function drainReady(tag: string, cutoff: string): Promise<Lead[]> {
  const leads: Lead[] = [];
  // seq — esp confirmed, eligible, not added/skipped
  let start = 0;
  for (;;) {
    const { data, error } = await supabase.from("nurture_sequence_finished")
      .select("id, ob_lead_id, email, esp").eq("client_tag", tag).not("esp", "is", null)
      .lte("sequence_finished_at", cutoff).is("added_at", null).not("skipped", "is", true)
      .order("sequence_finished_at", { ascending: true }).range(start, start + 999);
    if (error) { log(`  [${tag}] seq fetch error: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    for (const r of data) if (r.email) leads.push({ source: "seq", rowId: r.id, obLeadId: r.ob_lead_id ?? null, email: r.email, esp: effectiveEsp(r.esp, r.email) });
    if (data.length < 1000) break; start += 1000;
  }
  // replies — esp confirmed, safe, eligible
  start = 0;
  for (;;) {
    const { data, error } = await supabase.from("replies")
      .select("id, lead_id, lead_email, esp").eq("client_tag", tag).not("esp", "is", null)
      .eq("nurture_safety", "safe").lte("reply_time", cutoff).is("nurture_added_at", null).not("nurture_skipped", "is", true)
      .not("reply_we_got", "is", null).neq("reply_we_got", "")
      .or(`ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCL.map(c=>`"${c}"`).join(",")})`)
      .order("reply_time", { ascending: true }).range(start, start + 999);
    if (error) { log(`  [${tag}] replies fetch error: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    for (const r of data) if (r.lead_email) leads.push({ source: "reply", rowId: r.id, obLeadId: r.lead_id ?? null, email: r.lead_email, esp: effectiveEsp(r.esp, r.lead_email) });
    if (data.length < 1000) break; start += 1000;
  }
  return leads;
}

async function routeClient(tag: string, cutoff: string) {
  let inst = "outboundhero"; try { inst = await _resolve(tag); } catch {}
  // Find canonical campaigns per ESP (draft + active + paused).
  let camps: any[] = [];
  try { camps = await _list(inst, { search: `${tag}:`, statuses: ["draft", "active", "paused", "archived"] }); }
  catch (e) { log(`ROUTE ${tag}: campaign lookup FAILED ${(e as Error).message}`); return; }
  // Prefer a routable status, but fall back to archived (we can attach to
  // archived and resume it). active > paused > draft > archived.
  const rank = (s: string) => (s === "active" ? 0 : s === "paused" ? 1 : s === "draft" ? 2 : s === "archived" ? 3 : 4);
  const byEsp = new Map<Esp, any>();
  for (const c of camps) {
    // EXACT client-tag match (Bison search is fuzzy: "JPC:" returns "JPC&A:").
    if ((extractTagFromCampaignName(c.name) || "").toUpperCase() !== tag.toUpperCase()) continue;
    if (!isCanonicalNurtureCampaign(c.name)) continue;
    const esp = detectCampaignEsp(c.name); if (!esp) continue;
    const cur = byEsp.get(esp);
    if (!cur || rank(c.status) < rank(cur.status)) byEsp.set(esp, c);
  }
  const found = (["google","outlook","segs"] as Esp[]).map(e => byEsp.has(e) ? `${ESP_LABEL[e]}✓` : `${ESP_LABEL[e]}✗MISSING`).join(" ");

  const leads = await drainReady(tag, cutoff);
  const buckets: Record<Esp, Lead[]> = { google: [], outlook: [], segs: [] };
  for (const l of leads) buckets[l.esp].push(l);
  log(`ROUTE ${tag} [${inst}] campaigns: ${found} | ready: G=${buckets.google.length} O=${buckets.outlook.length} S=${buckets.segs.length}`);

  for (const esp of ["google","outlook","segs"] as Esp[]) {
    const items = buckets[esp]; if (items.length === 0) continue;
    const camp = byEsp.get(esp);
    if (!camp) { log(`  ${tag}/${ESP_LABEL[esp]}: ${items.length} ready but NO canonical campaign — SKIPPED`); continue; }
    // Resolve missing ids (replies only) via email lookup.
    const need = items.filter(i => !i.obLeadId);
    if (need.length > 0 && !DRY) {
      let idx = 0;
      await Promise.all(Array.from({ length: 5 }, async () => {
        while (idx < need.length) { const it = need[idx++]; try { const ld = await _find(inst, it.email); if (ld?.id) it.obLeadId = ld.id; } catch {} }
      }));
    }
    const ready = items.filter(i => i.obLeadId);
    if (DRY) { log(`  [dry] ${tag}/${ESP_LABEL[esp]} -> "${camp.name}" (id ${camp.id}, ${camp.status}): would attach ${ready.length}${need.length?` (${need.length} need id-lookup)`:""}`); continue; }
    // Attach in batches.
    let attached = 0;
    for (let i = 0; i < ready.length; i += ATTACH_BATCH) {
      const batch = ready.slice(i, i + ATTACH_BATCH);
      try {
        const r = await _attach(inst, camp.id, batch.map((b: Lead) => b.obLeadId!), true);
        if (r.ok) {
          attached += r.attachedCount ?? batch.length;
          const seqIds = batch.filter((b: Lead) => b.source === "seq").map((b: Lead) => b.rowId);
          const repIds = batch.filter((b: Lead) => b.source === "reply").map((b: Lead) => b.rowId);
          const stamp = new Date().toISOString();
          if (seqIds.length) await supabase.from("nurture_sequence_finished").update({ added_at: stamp, nurture_campaign_id: camp.id }).in("id", seqIds);
          if (repIds.length) await supabase.from("replies").update({ nurture_added_at: stamp, nurture_campaign_id: camp.id }).in("id", repIds);
        } else { log(`  ${tag}/${ESP_LABEL[esp]} batch attach error: ${r.error}`); }
      } catch (e) { log(`  ${tag}/${ESP_LABEL[esp]} batch threw: ${(e as Error).message}`); }
    }
    log(`  ${tag}/${ESP_LABEL[esp]} -> "${camp.name}" (id ${camp.id}): attached ${attached}/${ready.length}`);
  }
}

async function main() {
  log(`Auto-route ${DRY ? "[DRY RUN]" : "[LIVE]"} starting (${CLIENTS.length} clients)`);
  await load();
  const cutoff = new Date(Date.now() - NURTURE_DAYS * 864e5).toISOString();
  for (const tag of CLIENTS) {
    try { await routeClient(tag, cutoff); } catch (e) { log(`ROUTE ${tag}: FAILED ${(e as Error).message}`); }
  }
  log(`=== AUTO-ROUTE ${DRY ? "DRY " : ""}DONE ===`);
}
main().then(() => process.exit(0)).catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
