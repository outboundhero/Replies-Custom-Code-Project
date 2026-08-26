/**
 * Bulk-route a client's ARCHIVED (and optionally completed) source campaigns'
 * sequence-finished, no-reply leads into their nurture campaigns — the same
 * "route from campaign" feature, run locally over campaigns the 2-hourly sync
 * doesn't scan (archived).
 *
 * Accurate counting: leads are enumerated via CURSOR pagination (no 15k cap) and
 * DEDUPED by email per client, so the reported "distinct" is the true number that
 * would attach — not the overlap-inflated per-campaign sum. All campaigns across
 * all clients share ONE global concurrency pool so the cursor streams stay
 * saturated (a client with few-but-huge campaigns doesn't stall the run).
 *
 *   npx tsx scripts/bulk-route-archived.ts --dry-run                 # accurate counts
 *   npx tsx scripts/bulk-route-archived.ts --tags JPET,BBS           # real attach
 *   npx tsx scripts/bulk-route-archived.ts --statuses archived,completed --dry-run
 *
 * Flags: --tags A,B (default = the 15-client set) · --statuses (default
 * "archived") · --dry-run (count only) · --conc N (global campaign concurrency).
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { listCampaigns, listCampaignLeadsCursor, getCampaignLeadsPage, type OutboundLead } from "@/lib/outboundhero-api";
import { getClientInstances } from "@/lib/nurture/group-routing";
import { getCampaignMap } from "@/lib/nurture/campaign-map";
import { detectCampaignEsp, isCanonicalNurtureCampaign, type Esp } from "@/lib/nurture/esp";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import { isPersonalDomain } from "@/lib/processing/personal-domains";
import { routeCandidates, type Candidate } from "@/lib/nurture/route-candidates";
import db from "@/lib/db";
import supabaseMod from "@/lib/supabase";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = (supabaseMod as any).from ? supabaseMod : (supabaseMod as any).default;

import fs from "fs";
import path from "path";

const argv = process.argv.slice(2);
const flag = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes("--dry-run");
const CACHE_DIR = path.join(process.cwd(), ".archived-cache");
const STATUSES = (flag("--statuses", "archived") || "archived").split(",").map((s) => s.trim());
const DEFAULT_TAGS = ["DM4PM", "BAJFI", "SC", "CWSJ", "BBS", "ABM", "FSD", "CI", "SFS", "JPC", "RFS", "JPCI", "IJSD", "JPNNJ", "JPET"];
const TAGS = flag("--tags") ? flag("--tags")!.split(",").map((s) => s.trim().toUpperCase()) : DEFAULT_TAGS;
const CONC = Number(flag("--conc", "16")) || 16;

const instCache = new Map<string, Awaited<ReturnType<typeof listCampaigns>>>();
async function instCampaigns(inst: string) {
  if (!instCache.has(inst)) instCache.set(inst, await listCampaigns(inst, { statuses: STATUSES }));
  return instCache.get(inst)!;
}
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const m = i++;
      try { await fn(items[m]); } catch (e) { console.warn(`  ⚠ pool item failed: ${(e as Error).message}`); }
    }
  }));
}
async function recordRouted(TAG: string, rows: Array<[number, number]>) {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const ph = chunk.map(() => "(?,?,?)").join(",");
    const args = chunk.flatMap(([cid, lid]) => [TAG, cid, lid]);
    await db.execute({ sql: `INSERT OR IGNORE INTO nurture_source_routed (client_tag, source_campaign_id, ob_lead_id) VALUES ${ph}`, args });
  }
}

// Fast seq-finished fetch: parallel PAGE pagination (16-way internally) for
// campaigns up to ~15k seq leads (~1000 pages) — ~10-16× faster than sequential
// cursor. Cursor is used only for the rare >15k-seq campaigns where the page API
// is capped at 1000 pages.
async function fetchSeqLeadsFast(inst: string, campId: number, onProgress?: (n: number) => void): Promise<OutboundLead[]> {
  const PAGES = 100;
  const first = await getCampaignLeadsPage(inst, campId, 1, PAGES, { perPage: 100, leadCampaignStatus: "sequence_finished" });
  let leads = first.leads;
  onProgress?.(leads.length);
  if (first.lastPage <= PAGES) return leads;
  if (first.lastPage > 1000) {
    return await listCampaignLeadsCursor(inst, campId, { leadCampaignStatus: "sequence_finished", onProgress });
  }
  for (let start = PAGES + 1; start <= first.lastPage; start += PAGES) {
    const r = await getCampaignLeadsPage(inst, campId, start, Math.min(PAGES, first.lastPage - start + 1), { perPage: 100, leadCampaignStatus: "sequence_finished" });
    leads = leads.concat(r.leads);
    onProgress?.(leads.length);
  }
  return leads;
}

interface Camp { tag: string; id: number; inst: string; esp: Esp }

(async () => {
  console.log(`Bulk archived route (global fetch + per-client attach) — statuses=${STATUSES.join("+")} dryRun=${DRY} tags=${TAGS.length} conc=${CONC}\n`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const cInst: Record<string, { b2b: string; b2c: string } | null> = {};
  const need = new Set<string>();
  for (const t of TAGS) {
    const inst = await getClientInstances(t);
    cInst[t] = inst ? { b2b: inst.b2b, b2c: inst.b2c } : null;
    if (inst) { need.add(inst.b2b); need.add(inst.b2c); }
  }
  for (const inst of need) await instCampaigns(inst);

  let grandDistinct = 0, grandAttached = 0;

  // Per-client state. Build the global campaign list, ORDERED so the fastest
  // clients finish first: fully-cached clients (instant ✅), then smallest by
  // lead volume → visible wins immediately; the few huge clients grind at the end.
  const byEmail: Record<string, Map<string, Candidate & { _src: number }>> = {};
  const remaining: Record<string, number> = {};
  const failedCnt: Record<string, number> = {};
  const clientList: Array<{ tag: string; camps: Camp[]; allCached: boolean; vol: number }> = [];
  for (const TAG of TAGS) {
    const inst = cInst[TAG];
    if (!inst) { console.log(`${TAG}: no group — skip`); continue; }
    const doneMarker = path.join(CACHE_DIR, `done-${TAG}.json`);
    if (!DRY && fs.existsSync(doneMarker)) {
      try { const d = JSON.parse(fs.readFileSync(doneMarker, "utf8")); grandDistinct += d.distinct || 0; grandAttached += d.attached || 0; console.log(`✅ ${TAG}: already done (${(d.distinct || 0).toLocaleString()} distinct) — skip`); continue; } catch { /* redo */ }
    }
    const camps: Camp[] = [];
    let vol = 0;
    for (const ik of [...new Set([inst.b2b, inst.b2c])]) {
      for (const c of await instCampaigns(ik)) {
        if ((extractTagFromCampaignName(c.name) || "").toUpperCase() !== TAG) continue;
        if (isCanonicalNurtureCampaign(c.name)) continue;
        const esp = detectCampaignEsp(c.name); if (!esp) continue;
        if ((c.total_leads ?? 0) <= 0) continue;
        camps.push({ tag: TAG, id: c.id, inst: ik, esp });
        vol += c.total_leads ?? 0;
      }
    }
    if (camps.length === 0) { console.log(`${TAG}: no outbound source campaigns — skip`); continue; }
    const allCached = camps.every((c) => fs.existsSync(path.join(CACHE_DIR, `camp-${c.inst}-${c.id}.json`)));
    clientList.push({ tag: TAG, camps, allCached, vol });
  }
  // Fastest-first ordering: fully-cached → smallest lead volume → largest.
  clientList.sort((a, b) => (Number(b.allCached) - Number(a.allCached)) || (a.vol - b.vol));
  console.log(`Client order (fastest-first): ${clientList.map((c) => `${c.tag}${c.allCached ? "✓" : ""}`).join(" → ")}\n`);
  const allCamps: Camp[] = [];
  for (const cl of clientList) {
    byEmail[cl.tag] = new Map(); remaining[cl.tag] = cl.camps.length; failedCnt[cl.tag] = 0;
    allCamps.push(...cl.camps);
  }

  // Attach one client — called the instant its last campaign finishes fetching.
  async function attachClient(TAG: string) {
    const inst = cInst[TAG]!;
    const list = [...byEmail[TAG].values()];
    grandDistinct += list.length;
    if (DRY) { console.log(`  ✅ ${TAG}: ${list.length.toLocaleString()} distinct (dry-run)`); return; }
    const map = await getCampaignMap(TAG);
    if (map.length === 0) { console.log(`  ⚠ ${TAG}: no campaign map — skip attach (${list.length.toLocaleString()} distinct)`); return; }
    const srcOf = new Map<number, number>();
    for (const c of list) if (typeof c.obLeadId === "number") srcOf.set(c.obLeadId, c._src ?? 0);
    const b2bN = list.filter((c) => c.lane === "b2b").length, b2cN = list.length - b2bN;
    console.log(`\n  ${TAG}: ${list.length.toLocaleString()} distinct · B2B(${inst.b2b})=${b2bN.toLocaleString()} B2C(${inst.b2c})=${b2cN.toLocaleString()} · attaching…`);
    const tA = Date.now();
    const routed = await routeCandidates(TAG, list, map, {
      onAttached: async (campaignId, resolved) => {
        console.log(`    ✓ [${Math.round((Date.now() - tA) / 1000)}s] ${resolved.length.toLocaleString()} → campaign #${campaignId}`);
        const recs = resolved.map((r) => (typeof r.obLeadId === "number" ? [srcOf.get(r.obLeadId) ?? 0, r.obLeadId] as [number, number] : null)).filter((x): x is [number, number] => !!x && x[0] > 0);
        if (recs.length) await recordRouted(TAG, recs);
        const nowIso = new Date().toISOString();
        const rows = resolved.filter((r) => typeof r.obLeadId === "number" && r.sourceInstance).map((r) => ({ ob_lead_id: r.obLeadId, ob_campaign_id: srcOf.get(r.obLeadId!) ?? 0, client_tag: TAG, email: r.email, esp: r.esp, bison_instance: r.sourceInstance, sequence_finished_at: nowIso, synced_at: nowIso, added_at: nowIso, nurture_campaign_id: campaignId }));
        for (let i = 0; i < rows.length; i += 500) { const { error } = await supabase.from("nurture_sequence_finished").upsert(rows.slice(i, i + 500), { onConflict: "ob_lead_id,ob_campaign_id,bison_instance" }); if (error) console.warn(`    ⚠ seq upsert error: ${error.message}`); }
      },
    });
    for (const b of routed.perBucket) console.log(`    ${b.instance.padEnd(15)} ${b.lane.toUpperCase()} ${b.esp.padEnd(7)} → ${(b.campaign.name || "").slice(0, 42).padEnd(42)} req=${String(b.requested).padStart(6)} attached=${String(b.attached).padStart(6)}${b.error ? `  ⚠ ${b.error}` : ""}`);
    grandAttached += routed.totalAttached;
    const complete = failedCnt[TAG] === 0;
    console.log(`  ✅ ${TAG}: attached ${routed.totalAttached.toLocaleString()} of ${list.length.toLocaleString()} distinct${complete ? "" : "  (some campaigns failed — re-run to finish)"}`);
    if (complete) fs.writeFileSync(path.join(CACHE_DIR, `done-${TAG}.json`), JSON.stringify({ distinct: list.length, attached: routed.totalAttached, at: new Date().toISOString() }));
  }

  // GLOBAL 16-stream fetch; each client attaches the moment its campaigns finish.
  console.log(`Fetching ${allCamps.length} campaigns across ${Object.keys(remaining).length} client(s) at conc=${CONC}…\n`);
  let totalFetched = 0, cdone = 0, inFlight = 0;
  const t0 = Date.now();
  const hb = setInterval(() => {
    const el = Math.round((Date.now() - t0) / 1000);
    const rate = Math.round(totalFetched / Math.max(1, el));
    const dsum = Object.values(byEmail).reduce((a, m) => a + m.size, 0);
    console.log(`  [${el}s] campaigns ${cdone}/${allCamps.length} (${inFlight} in-flight) · fetched ${totalFetched.toLocaleString()} (${rate}/s) · distinct ${dsum.toLocaleString()}`);
  }, 20000);
  await pool(allCamps, CONC, async (c) => {
    const cf = path.join(CACHE_DIR, `camp-${c.inst}-${c.id}.json`);
    let camCands: Array<Candidate & { _src: number }>;
    if (fs.existsSync(cf)) {
      try { camCands = JSON.parse(fs.readFileSync(cf, "utf8")); } catch { camCands = []; }
    } else {
      inFlight++;
      let leads: OutboundLead[] = [];
      try { let last = 0; leads = await listCampaignLeadsCursor(c.inst, c.id, { leadCampaignStatus: "sequence_finished", onProgress: (f) => { totalFetched += f - last; last = f; } }); }
      catch (e) { console.warn(`  ⚠ ${c.tag} #${c.id} fetch failed: ${(e as Error).message}`); inFlight--; failedCnt[c.tag]++; cdone++; if (--remaining[c.tag] === 0) await attachClient(c.tag); return; }
      inFlight--;
      const inst = cInst[c.tag]!;
      camCands = [];
      for (const l of leads) {
        const email = (l.email || "").toLowerCase(); if (!email) continue;
        if (l.status === "bounced") continue;
        if ((l.overall_stats?.replies ?? 0) > 0) continue;
        const lane: "b2b" | "b2c" = isPersonalDomain(email) ? "b2c" : "b2b";
        camCands.push({ source: "campaign", rowId: l.id, email, esp: c.esp, first_name: l.first_name ?? null, last_name: l.last_name ?? null, company: l.company ?? null, obLeadId: l.id, sourceInstance: c.inst, custom_variables: Array.isArray(l.custom_variables) ? l.custom_variables.filter((v) => v && v.name && v.value != null) : [], lane, instance: inst[lane], _src: c.id });
      }
      fs.writeFileSync(cf, JSON.stringify(camCands));
    }
    const m = byEmail[c.tag];
    for (const cand of camCands) if (!m.has(cand.email)) m.set(cand.email, cand);
    cdone++;
    if (--remaining[c.tag] === 0) await attachClient(c.tag);
  });
  clearInterval(hb);
  console.log(`\n══════ GRAND TOTAL ══════  distinct=${grandDistinct.toLocaleString()}${DRY ? "  (dry-run)" : `  attached=${grandAttached.toLocaleString()}`}`);
})().then(() => process.exit(0)).catch((e) => { console.error("FATAL", e); process.exit(1); });
