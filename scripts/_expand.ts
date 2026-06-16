/**
 * Expansion backfill — ACTIVE clients only (churned excluded via Client Tracker).
 *   Phase A: sync sequence-finished for active clients not yet synced, then
 *            Tier-1 ESP backfill (eligible/Ready leads) for every active client.
 *   Phase B: Tier-2 ESP backfill (Waiting leads) for every active client.
 *
 * Active set = tags appearing in an "Active/Paused/Limited" row of the Client
 * Tracker (so HS counts as active; SBCC/JPK stay excluded as churned-only).
 *
 * Run: npx tsx scripts/_expand.ts
 *      npx tsx scripts/_expand.ts --phase a   (sync + tier1 only)
 *      npx tsx scripts/_expand.ts --phase b   (tier2 only)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { appendFileSync } from "fs";
import supabase from "../lib/supabase";
import { pickEspFromTags, bucketEsp } from "../lib/nurture/esp";

const RESULTS = "/tmp/expand.txt";
const NURTURE_DAYS = 45;
const args = process.argv.slice(2);
const LOOKUP_CONCURRENCY = (() => { const i = args.indexOf("--concurrency"); return i >= 0 ? Math.max(1, Number(args[i + 1]) || 8) : 8; })();
const cutoff = new Date(Date.now() - NURTURE_DAYS * 864e5).toISOString();
const PHASE = (() => { const i = args.indexOf("--phase"); return i >= 0 ? args[i + 1]?.toLowerCase() : "all"; })();
// --group i/n → process only clients where index % n === i (run N processes in
// parallel, each a disjoint third/quarter of the active list, to use more of
// Bison's rate ceiling). Default: all clients (group 0/1).
const GROUP = (() => {
  const i = args.indexOf("--group"); if (i < 0) return { i: 0, n: 1 };
  const [a, b] = (args[i + 1] || "0/1").split("/").map(Number);
  return { i: a || 0, n: b || 1 };
})();
const TAG = `g${GROUP.i}/${GROUP.n}`;

function log(s: string) { const l = `${new Date().toISOString().slice(11, 19)} [${TAG}] ${s}`; console.log(l); appendFileSync(RESULTS, l + "\n"); }

let _sync: any, _resolve: any, _find: any;
async function load() {
  const s = await import("../lib/nurture/sync-sequence-finished");
  const bi = await import("../lib/bison-instances");
  const api = await import("../lib/outboundhero-api");
  _sync = s.syncOneClient; _resolve = bi.resolveInstanceForClient; _find = api.findLeadByEmail;
}

async function activeClients(): Promise<string[]> {
  const { fetchClientTracker } = await import("../lib/google-sheets");
  const { default: db } = await import("../lib/db");
  const rows = await fetchClientTracker();
  const split = (s: string) => s.split(/\s+&\s+|\s+and\s+/i).map((x) => x.trim().toUpperCase()).filter(Boolean);
  const active = new Set<string>();
  for (const r of rows) if (!/churn/i.test(r.status)) for (const t of split(r.clientAbbreviation)) active.add(t);
  const dbTags = (await db.execute("SELECT tag FROM client_tags")).rows.map((r: any) => r.tag as string);
  return dbTags.filter((t) => active.has(t.toUpperCase())).sort();
}

/** Drain null-esp leads for a client+tier, look up Bison tags, set esp. */
async function backfill(tag: string, tier: "eligible" | "waiting") {
  const jobs: { id: number; email: string }[] = [];
  let start = 0;
  for (;;) {
    let q = supabase.from("nurture_sequence_finished").select("id, email")
      .eq("client_tag", tag).is("esp", null).is("added_at", null).not("skipped", "is", true);
    q = tier === "eligible" ? q.lte("sequence_finished_at", cutoff) : q.gt("sequence_finished_at", cutoff);
    const { data, error } = await q.order("sequence_finished_at", { ascending: true }).range(start, start + 999);
    if (error) { log(`  [${tag}/${tier}] fetch err: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    for (const r of data) if (r.email) jobs.push({ id: r.id, email: r.email });
    if (data.length < 1000) break; start += 1000;
  }
  if (jobs.length === 0) return { filled: 0, tally: { google: 0, outlook: 0, segs: 0 } };
  let inst = "outboundhero"; try { inst = await _resolve(tag); } catch {}
  const tally = { google: 0, outlook: 0, segs: 0 };
  let filled = 0, idx = 0;
  const cache = new Map<string, string | null>();
  await Promise.all(Array.from({ length: LOOKUP_CONCURRENCY }, async () => {
    while (idx < jobs.length) {
      const j = jobs[idx++];
      let esp = cache.get(j.email);
      if (esp === undefined) { try { const ld = await _find(inst, j.email); esp = pickEspFromTags(ld?.tags); } catch { esp = null; } cache.set(j.email, esp ?? null); }
      if (!esp) continue;
      tally[bucketEsp(esp)]++;
      const { error } = await supabase.from("nurture_sequence_finished").update({ esp }).eq("id", j.id);
      if (!error) filled++;
    }
  }));
  return { filled, tally };
}

async function main() {
  log(`Expansion starting (phase=${PHASE})`);
  await load();
  let clients = await activeClients();
  if (GROUP.n > 1) clients = clients.filter((_, idx) => idx % GROUP.n === GROUP.i);
  log(`Active clients to process: ${clients.length}`);

  if (PHASE === "all" || PHASE === "a") {
    log(`=== Phase A: sync (if needed) + Tier-1 (Ready) ===`);
    for (const tag of clients) {
      const { count } = await supabase.from("nurture_sequence_finished").select("id", { count: "exact", head: true }).eq("client_tag", tag);
      if ((count ?? 0) === 0) {
        let inst = "outboundhero"; try { inst = await _resolve(tag); } catch {}
        try { const r = await _sync(inst, tag, { maxPagesPerCampaign: Infinity }); log(`SYNC ${tag}: candidates=${r.candidatesFound} upserted=${r.upserted} errors=${r.errors.length}`); }
        catch (e) { log(`SYNC ${tag}: FAILED ${(e as Error).message}`); }
      }
      try { const b = await backfill(tag, "eligible"); log(`TIER1 ${tag}: filled=${b.filled} | g=${b.tally.google} o=${b.tally.outlook} s=${b.tally.segs}`); }
      catch (e) { log(`TIER1 ${tag}: FAILED ${(e as Error).message}`); }
    }
    log(`=== Phase A DONE ===`);
  }

  if (PHASE === "all" || PHASE === "b") {
    log(`=== Phase B: Tier-2 (Waiting) ===`);
    for (const tag of clients) {
      try { const b = await backfill(tag, "waiting"); log(`TIER2 ${tag}: filled=${b.filled} | g=${b.tally.google} o=${b.tally.outlook} s=${b.tally.segs}`); }
      catch (e) { log(`TIER2 ${tag}: FAILED ${(e as Error).message}`); }
    }
    log(`=== Phase B DONE ===`);
  }
  log(`=== EXPANSION DONE ===`);
}
main().then(() => process.exit(0)).catch((e) => { log(`FATAL: ${e.message}`); process.exit(1); });
