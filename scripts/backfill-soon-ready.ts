/**
 * Priority ESP backfill — "soon-ready" waiting leads first.
 *
 * The full waiting backfill is ~525k leads (~9h at Bison's serialized lookup
 * rate). But every waiting lead is still inside its 45-day cooldown, so ESP is
 * only needed as a lead approaches the cutoff. This fills the MOST URGENT leads
 * first — those that cross the 45-day mark soonest — within a wall-clock time
 * budget, then stops. The long tail is left for the background full run / cron.
 *
 * Ordering: sequence_finished_at ASC = oldest finish dates = become Ready first.
 *
 * Run: npx tsx scripts/backfill-soon-ready.ts [--minutes 55] [--concurrency 8] [--window-days 14]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { appendFileSync } from "fs";
import supabase from "../lib/supabase";
import { pickEspFromTags } from "../lib/nurture/esp";
import { resolveInstanceForClient } from "../lib/bison-instances";
import { findLeadByEmail } from "../lib/outboundhero-api";
import { fetchClientTracker } from "../lib/google-sheets";
import db from "../lib/db";

async function activeClients(): Promise<string[]> {
  const rows = await fetchClientTracker();
  const split = (s: string) => s.split(/\s+&\s+|\s+and\s+/i).map((x) => x.trim().toUpperCase()).filter(Boolean);
  const active = new Set<string>();
  for (const r of rows) if (!/churn/i.test(r.status)) for (const t of split(r.clientAbbreviation)) active.add(t);
  const dbTags = (await db.execute("SELECT tag FROM client_tags")).rows.map((r: any) => String(r.tag));
  return dbTags.filter((t) => active.has(t.toUpperCase()));
}

const RESULTS = "/tmp/soon-ready.txt";
const args = process.argv.slice(2);
const argn = (flag: string, def: number) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) || def : def; };
const MAX_MINUTES = argn("--minutes", 55);
const CONCURRENCY = argn("--concurrency", 8);
const WINDOW_DAYS = argn("--window-days", 14);
const day = 864e5;
const startMs = Date.now();
const cutoff = new Date(startMs - 45 * day).toISOString();
const windowHi = new Date(startMs - (45 - WINDOW_DAYS) * day).toISOString();
const deadline = startMs + MAX_MINUTES * 60_000;

function log(s: string) {
  const l = `${new Date().toISOString().slice(11, 19)} ${s}`;
  console.log(l); appendFileSync(RESULTS, l + "\n");
}

async function main() {
  log(`SOON-READY backfill: window=${WINDOW_DAYS}d concurrency=${CONCURRENCY} budget=${MAX_MINUTES}min`);

  // Pull the candidate pool PER CLIENT. Whole-table ordered queries time out on
  // this 2M-row table (and offset-with-ties duplicates+drops rows). Per-client
  // queries hit the (client_tag, sequence_finished_at) index and are fast, so we
  // load each active client's window leads, then merge + sort soonest-first in
  // memory for correct global prioritisation.
  const tags = await activeClients();
  log(`active clients: ${tags.length}`);
  const raw: { id: number; email: string; tag: string; sfa: string }[] = [];
  for (const tag of tags) {
    let start = 0;
    for (;;) {
      const { data, error } = await supabase.from("nurture_sequence_finished")
        .select("id, email, sequence_finished_at")
        .eq("client_tag", tag)
        .is("esp", null).is("added_at", null).not("skipped", "is", true)
        .gt("sequence_finished_at", cutoff).lte("sequence_finished_at", windowHi)
        .order("sequence_finished_at", { ascending: true })
        .range(start, start + 999);
      if (error) { log(`  ${tag} fetch err: ${error.message}`); break; }
      if (!data || data.length === 0) break;
      for (const r of data) if (r.email) raw.push({ id: r.id as number, email: r.email as string, tag, sfa: String(r.sequence_finished_at) });
      if (data.length < 1000) break;
      start += 1000;
    }
  }
  raw.sort((a, b) => (a.sfa < b.sfa ? -1 : a.sfa > b.sfa ? 1 : 0)); // soonest-ready first, globally
  const pool: { id: number; email: string; tag: string }[] = raw;
  log(`pool loaded: ${pool.length.toLocaleString()} candidate leads (soonest-ready first, per-client merge)`);

  // Pre-resolve instance per distinct client tag.
  const instByTag = new Map<string, string>();
  for (const tag of new Set(pool.map((p) => p.tag))) {
    try { instByTag.set(tag, await resolveInstanceForClient(tag)); } catch { instByTag.set(tag, "outboundhero"); }
  }

  // Worker pool. Stop pulling new work at the deadline.
  let idx = 0, filled = 0, looked = 0, nullEsp = 0;
  const tally = { google: 0, outlook: 0, segs: 0 } as Record<string, number>;
  let lastLog = Date.now();

  async function worker() {
    while (idx < pool.length && Date.now() < deadline) {
      const j = pool[idx++];
      looked++;
      let esp: string | null = null;
      try { const ld = await findLeadByEmail(instByTag.get(j.tag) || "outboundhero", j.email); esp = pickEspFromTags(ld?.tags) ?? null; } catch { esp = null; }
      if (!esp) { nullEsp++; continue; }
      const bucket = /outlook/i.test(esp) ? "outlook" : /google|gmail/i.test(esp) ? "google" : "segs";
      tally[bucket]++;
      const { error } = await supabase.from("nurture_sequence_finished").update({ esp }).eq("id", j.id);
      if (!error) filled++;
      if (Date.now() - lastLog > 30_000) {
        lastLog = Date.now();
        const mins = ((Date.now() - startMs) / 60000).toFixed(1);
        log(`  +${mins}min: looked=${looked.toLocaleString()} filled=${filled.toLocaleString()} (g=${tally.google} o=${tally.outlook} s=${tally.segs}) | rate=${(looked / ((Date.now() - startMs) / 1000)).toFixed(1)}/s`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const mins = ((Date.now() - startMs) / 60000).toFixed(1);
  const done = idx >= pool.length;
  log(`DONE in ${mins}min: looked=${looked.toLocaleString()} filled=${filled.toLocaleString()} null=${nullEsp.toLocaleString()} (g=${tally.google} o=${tally.outlook} s=${tally.segs}) | ${done ? "pool exhausted" : "hit time budget — " + (pool.length - idx).toLocaleString() + " left in window"}`);
}
main().then(() => process.exit(0)).catch((e) => { log(`FATAL: ${e.message}`); process.exit(1); });
