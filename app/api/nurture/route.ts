/**
 * GET /api/nurture
 *
 * Returns nurture-eligible candidates from two data sources:
 *   1. Replies (Scenarios 1 + 2) — bucket is determined by the safety
 *      classifier from the reply text itself, NOT by the original AI category.
 *   2. nurture_sequence_finished (Scenario 3) — synced from EmailBison.
 *
 * 45-day eligibility is computed at query time:
 *   trigger = reply_time (replies) or sequence_finished_at (sequence)
 *   eligible_at = trigger + 45 days
 *
 * Query params:
 *   source       "soft_negative" | "out_of_office" | "sequence_finished" | "all"  (default all)
 *   client_tag   filter by client
 *   status       "waiting" | "eligible" | "added" | "skipped" | "all"            (default all)
 *   safety       "safe" | "unsafe" | "unknown" | "unclassified" | "all"          (default all; n/a for sequence_finished)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import supabase from "@/lib/supabase";

const NURTURE_DAYS = 45;
const BATCH_SIZE = 1000;

async function fetchAllRows<T>(buildQuery: (from: number, to: number) => any): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await buildQuery(offset, offset + BATCH_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }
  return all;
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));
}

interface NurtureItem {
  id: string;
  source: "soft_negative" | "out_of_office" | "sequence_finished" | "other";
  client_tag: string | null;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  trigger_at: string;
  eligible_at: string;
  days_until_eligible: number;
  is_eligible: boolean;
  added_at: string | null;
  skipped: boolean;
  reply_id?: number;
  ai_category?: string | null;
  reply_text?: string | null;
  nurture_safety?: string | null;
  nurture_bucket?: string | null;
  nurture_safety_reason?: string | null;
  nurture_classified_at?: string | null;
  ob_lead_id?: number;
  ob_campaign_id?: number;
  campaign_name?: string;
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const sourceParam = req.nextUrl.searchParams.get("source") || "all";
    const clientTag = req.nextUrl.searchParams.get("client_tag");
    const statusFilter = req.nextUrl.searchParams.get("status") || "all";
    const safetyFilter = req.nextUrl.searchParams.get("safety") || "all";

    const items: NurtureItem[] = [];
    const now = new Date();

    // ── Replies-based candidates (Scenarios 1 + 2) ──
    // Pull every reply with non-empty text and reply_time.
    // Bucket / safety is decided by the classifier (stored in nurture_bucket /
    // nurture_safety). Unclassified rows show up with bucket = null.
    if (sourceParam === "all" || sourceParam === "soft_negative" || sourceParam === "out_of_office") {
      const replies = await fetchAllRows<{
        id: number;
        reply_id: number;
        client_tag: string | null;
        lead_email: string;
        first_name: string | null;
        last_name: string | null;
        company_name: string | null;
        ai_categorized_lead_category: string | null;
        reply_we_got: string | null;
        reply_time: string | null;
        nurture_safety: string | null;
        nurture_bucket: string | null;
        nurture_safety_reason: string | null;
        nurture_classified_at: string | null;
        nurture_added_at: string | null;
        nurture_skipped: boolean | null;
      }>((from, to) => {
        let q = supabase
          .from("replies")
          .select("id, reply_id, client_tag, lead_email, first_name, last_name, company_name, ai_categorized_lead_category, reply_we_got, reply_time, nurture_safety, nurture_bucket, nurture_safety_reason, nurture_classified_at, nurture_added_at, nurture_skipped")
          .not("reply_we_got", "is", null)
          .neq("reply_we_got", "")
          .not("reply_time", "is", null)
          .order("reply_time", { ascending: false })
          .range(from, to);
        if (clientTag) q = q.eq("client_tag", clientTag);
        return q;
      });

      for (const r of replies) {
        if (!r.reply_time) continue;

        // Determine display source from classifier output (bucket).
        // Unclassified rows or "other" rows fall into "other" group.
        let source: NurtureItem["source"];
        if (r.nurture_bucket === "out_of_office") source = "out_of_office";
        else if (r.nurture_bucket === "soft_negative") source = "soft_negative";
        else source = "other";

        // Source param filter — "soft_negative" or "out_of_office" only matches that bucket
        if (sourceParam === "soft_negative" && source !== "soft_negative") continue;
        if (sourceParam === "out_of_office" && source !== "out_of_office") continue;

        const triggerAt = new Date(r.reply_time);
        const eligibleAt = new Date(triggerAt.getTime() + NURTURE_DAYS * 24 * 60 * 60 * 1000);
        const daysLeft = daysBetween(eligibleAt, now);
        const isEligible = daysLeft <= 0;

        items.push({
          id: `reply:${r.id}`,
          source,
          client_tag: r.client_tag,
          email: r.lead_email,
          first_name: r.first_name,
          last_name: r.last_name,
          company: r.company_name,
          trigger_at: r.reply_time,
          eligible_at: eligibleAt.toISOString(),
          days_until_eligible: daysLeft,
          is_eligible: isEligible,
          added_at: r.nurture_added_at,
          skipped: !!r.nurture_skipped,
          reply_id: r.reply_id,
          ai_category: r.ai_categorized_lead_category,
          reply_text: r.reply_we_got,
          nurture_safety: r.nurture_safety,
          nurture_bucket: r.nurture_bucket,
          nurture_safety_reason: r.nurture_safety_reason,
          nurture_classified_at: r.nurture_classified_at,
        });
      }
    }

    // ── Sequence-finished candidates (Scenario 3) ──
    if (sourceParam === "all" || sourceParam === "sequence_finished") {
      const seqRows = await fetchAllRows<{
        id: number;
        ob_lead_id: number;
        ob_campaign_id: number;
        campaign_name: string | null;
        client_tag: string | null;
        email: string;
        first_name: string | null;
        last_name: string | null;
        company: string | null;
        sequence_finished_at: string;
        added_at: string | null;
        skipped: boolean | null;
      }>((from, to) => {
        let q = supabase
          .from("nurture_sequence_finished")
          .select("id, ob_lead_id, ob_campaign_id, campaign_name, client_tag, email, first_name, last_name, company, sequence_finished_at, added_at, skipped")
          .order("sequence_finished_at", { ascending: false })
          .range(from, to);
        if (clientTag) q = q.eq("client_tag", clientTag);
        return q;
      });

      for (const r of seqRows) {
        const triggerAt = new Date(r.sequence_finished_at);
        const eligibleAt = new Date(triggerAt.getTime() + NURTURE_DAYS * 24 * 60 * 60 * 1000);
        const daysLeft = daysBetween(eligibleAt, now);
        const isEligible = daysLeft <= 0;

        items.push({
          id: `seq:${r.id}`,
          source: "sequence_finished",
          client_tag: r.client_tag,
          email: r.email,
          first_name: r.first_name,
          last_name: r.last_name,
          company: r.company,
          trigger_at: r.sequence_finished_at,
          eligible_at: eligibleAt.toISOString(),
          days_until_eligible: daysLeft,
          is_eligible: isEligible,
          added_at: r.added_at,
          skipped: !!r.skipped,
          ob_lead_id: r.ob_lead_id,
          ob_campaign_id: r.ob_campaign_id,
          campaign_name: r.campaign_name || undefined,
        });
      }
    }

    // ── Apply post-filters: status + safety ──
    const filtered = items.filter((it) => {
      if (statusFilter !== "all") {
        if (statusFilter === "added" && !it.added_at) return false;
        if (statusFilter === "skipped" && !it.skipped) return false;
        if (statusFilter === "waiting" && (it.is_eligible || it.added_at || it.skipped)) return false;
        if (statusFilter === "eligible" && (!it.is_eligible || it.added_at || it.skipped)) return false;
      }
      if (safetyFilter !== "all" && it.source !== "sequence_finished") {
        if (safetyFilter === "unclassified" && it.nurture_safety) return false;
        if (safetyFilter !== "unclassified" && it.nurture_safety !== safetyFilter) return false;
      }
      return true;
    });

    // ── Aggregate counts for the UI ──
    const counts = {
      total: filtered.length,
      bySource: {
        soft_negative: 0,
        out_of_office: 0,
        sequence_finished: 0,
        other: 0,
      } as Record<string, number>,
      byStatus: {
        waiting: 0,
        eligible: 0,
        added: 0,
        skipped: 0,
      } as Record<string, number>,
      bySafety: {
        safe: 0,
        unsafe: 0,
        unknown: 0,
        unclassified: 0,
      } as Record<string, number>,
    };
    for (const it of filtered) {
      counts.bySource[it.source]++;
      if (it.added_at) counts.byStatus.added++;
      else if (it.skipped) counts.byStatus.skipped++;
      else if (it.is_eligible) counts.byStatus.eligible++;
      else counts.byStatus.waiting++;
      if (it.source !== "sequence_finished") {
        if (!it.nurture_safety) counts.bySafety.unclassified++;
        else if (it.nurture_safety === "safe") counts.bySafety.safe++;
        else if (it.nurture_safety === "unsafe") counts.bySafety.unsafe++;
        else counts.bySafety.unknown++;
      }
    }

    return NextResponse.json({ items: filtered, counts });
  } catch (error) {
    console.error("[api/nurture] GET failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
