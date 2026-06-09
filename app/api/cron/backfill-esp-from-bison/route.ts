/**
 * GET /api/cron/backfill-esp-from-bison
 *
 * Server-side version of scripts/backfill-esp-from-bison.ts so the
 * backfill can run from inside Vercel where the BISON_*_TOKEN env
 * vars actually live. Same three priority tiers, same logic.
 *
 * Query params:
 *   secret: must match CRON_SECRET
 *   tier:   1 (Ready), 2 (Waiting), 3 (Already-pushed). Default 1.
 *   client: optional client tag to scope to a single client (e.g. JPH)
 *   dry:    "1" to print decisions without writing
 *
 * Caps at 800 leads per call to fit inside Vercel's 5-min route budget
 * comfortably. Operator hits the endpoint repeatedly until the
 * "filled" count drops to ~0; each call burns through 800 more.
 */
import { NextRequest, NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { resolveInstanceForClient } from "@/lib/bison-instances";
import { findLeadByEmail } from "@/lib/outboundhero-api";
import { pickEspFromTags } from "@/lib/nurture/esp";

export const maxDuration = 300;

const NURTURE_DAYS = 45;
const PER_CALL_CAP = 800;
const CONCURRENCY = 5;

const EXCLUDED_AI_CATEGORIES = [
  "Interested", "Meeting Request", "Meeting Set", "Do Not Contact",
  "Wrong Person", "Wrong Person (Change of Target)", "Not Interested",
  "Mailbox No Longer Active", "Automated Error Message",
  "Automated Catch-All Message", "Referral Given", "Internally Forwarded",
];

interface Job {
  source: "seq" | "reply" | "legacy";
  rowId: number;
  email: string;
  clientTag: string | null;
}

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tier = Number(req.nextUrl.searchParams.get("tier") || 1);
  const clientFilter = req.nextUrl.searchParams.get("client")?.toUpperCase() || undefined;
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let jobs: Job[] = [];
  if (tier === 1) jobs = await fetchTier1(cutoffIso, clientFilter);
  else if (tier === 2) jobs = await fetchTier2(cutoffIso, clientFilter);
  else if (tier === 3) jobs = await fetchTier3(clientFilter);
  else return NextResponse.json({ error: "Unknown tier; use 1, 2, or 3" }, { status: 400 });

  // Cap so we fit inside the 5-min route budget even on slow Bison.
  jobs = jobs.slice(0, PER_CALL_CAP);

  if (jobs.length === 0) {
    return NextResponse.json({ ok: true, tier, clientFilter, dryRun, filled: 0, skipped: 0, jobs: 0, message: "Nothing to do at this tier." });
  }

  const espCache = new Map<string, string | null>();
  async function lookupEsp(email: string, clientTag: string | null): Promise<string | null> {
    const cached = espCache.get(email);
    if (cached !== undefined) return cached;
    let instance: string = "outboundhero";
    if (clientTag) {
      try { instance = await resolveInstanceForClient(clientTag); } catch { /* default */ }
    }
    try {
      const lead = await findLeadByEmail(instance, email);
      const esp = pickEspFromTags(lead?.tags);
      espCache.set(email, esp);
      return esp;
    } catch {
      espCache.set(email, null);
      return null;
    }
  }

  let filled = 0, skipped = 0;
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      while (idx < jobs.length) {
        const j = jobs[idx++];
        const esp = await lookupEsp(j.email, j.clientTag);
        if (!esp) { skipped++; continue; }
        if (dryRun) { filled++; continue; }
        const table = j.source === "seq" ? "nurture_sequence_finished"
                    : j.source === "reply" ? "replies"
                    : "nurture_legacy_leads";
        const { error } = await supabase.from(table).update({ esp }).eq("id", j.rowId);
        if (!error) filled++;
      }
    }),
  );

  return NextResponse.json({
    ok: true, tier, clientFilter, dryRun,
    jobs: jobs.length, filled, skipped,
    hint: filled === PER_CALL_CAP ? `Hit per-call cap (${PER_CALL_CAP}). Hit this URL again to continue.` : "Done with available rows at this tier.",
  });
}

async function fetchTier1(cutoffIso: string, clientFilter?: string): Promise<Job[]> {
  const jobs: Job[] = [];
  let q = supabase.from("nurture_sequence_finished")
    .select("id, email, client_tag")
    .is("esp", null)
    .lte("sequence_finished_at", cutoffIso)
    .is("added_at", null)
    .not("skipped", "is", true);
  if (clientFilter) q = q.eq("client_tag", clientFilter);
  const { data: seqRows } = await q.limit(PER_CALL_CAP);
  for (const r of seqRows || []) {
    if (!r.email) continue;
    jobs.push({ source: "seq", rowId: r.id as number, email: r.email as string, clientTag: r.client_tag as string | null });
  }
  if (jobs.length >= PER_CALL_CAP) return jobs;

  let qr = supabase.from("replies")
    .select("id, lead_email, client_tag")
    .is("esp", null)
    .eq("nurture_safety", "safe")
    .lte("reply_time", cutoffIso)
    .is("nurture_added_at", null)
    .not("nurture_skipped", "is", true)
    .not("reply_we_got", "is", null).neq("reply_we_got", "")
    .or(`ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`);
  if (clientFilter) qr = qr.eq("client_tag", clientFilter);
  const { data: replyRows } = await qr.limit(PER_CALL_CAP - jobs.length);
  for (const r of replyRows || []) {
    if (!r.lead_email) continue;
    jobs.push({ source: "reply", rowId: r.id as number, email: r.lead_email as string, clientTag: r.client_tag as string | null });
  }
  if (jobs.length >= PER_CALL_CAP) return jobs;

  let ql = supabase.from("nurture_legacy_leads")
    .select("id, lead_email, client_tag")
    .is("esp", null)
    .eq("nurture_safety", "safe")
    .lte("reply_at", cutoffIso)
    .is("nurture_added_at", null)
    .not("nurture_skipped", "is", true);
  if (clientFilter) ql = ql.eq("client_tag", clientFilter);
  const { data: legacyRows } = await ql.limit(PER_CALL_CAP - jobs.length);
  for (const r of legacyRows || []) {
    if (!r.lead_email) continue;
    jobs.push({ source: "legacy", rowId: r.id as number, email: r.lead_email as string, clientTag: r.client_tag as string | null });
  }
  return jobs;
}

async function fetchTier2(cutoffIso: string, clientFilter?: string): Promise<Job[]> {
  const jobs: Job[] = [];
  let q = supabase.from("nurture_sequence_finished")
    .select("id, email, client_tag")
    .is("esp", null)
    .gt("sequence_finished_at", cutoffIso)
    .is("added_at", null);
  if (clientFilter) q = q.eq("client_tag", clientFilter);
  const { data: seqRows } = await q.limit(PER_CALL_CAP);
  for (const r of seqRows || []) {
    if (!r.email) continue;
    jobs.push({ source: "seq", rowId: r.id as number, email: r.email as string, clientTag: r.client_tag as string | null });
  }
  if (jobs.length >= PER_CALL_CAP) return jobs;
  let qr = supabase.from("replies")
    .select("id, lead_email, client_tag")
    .is("esp", null)
    .gt("reply_time", cutoffIso)
    .is("nurture_added_at", null);
  if (clientFilter) qr = qr.eq("client_tag", clientFilter);
  const { data: replyRows } = await qr.limit(PER_CALL_CAP - jobs.length);
  for (const r of replyRows || []) {
    if (!r.lead_email) continue;
    jobs.push({ source: "reply", rowId: r.id as number, email: r.lead_email as string, clientTag: r.client_tag as string | null });
  }
  return jobs;
}

async function fetchTier3(clientFilter?: string): Promise<Job[]> {
  const jobs: Job[] = [];
  let q = supabase.from("nurture_sequence_finished")
    .select("id, email, client_tag")
    .is("esp", null)
    .not("added_at", "is", null);
  if (clientFilter) q = q.eq("client_tag", clientFilter);
  const { data: seqRows } = await q.limit(PER_CALL_CAP);
  for (const r of seqRows || []) {
    if (!r.email) continue;
    jobs.push({ source: "seq", rowId: r.id as number, email: r.email as string, clientTag: r.client_tag as string | null });
  }
  if (jobs.length >= PER_CALL_CAP) return jobs;
  let qr = supabase.from("replies")
    .select("id, lead_email, client_tag")
    .is("esp", null)
    .not("nurture_added_at", "is", null);
  if (clientFilter) qr = qr.eq("client_tag", clientFilter);
  const { data: replyRows } = await qr.limit(PER_CALL_CAP - jobs.length);
  for (const r of replyRows || []) {
    if (!r.lead_email) continue;
    jobs.push({ source: "reply", rowId: r.id as number, email: r.lead_email as string, clientTag: r.client_tag as string | null });
  }
  return jobs;
}
