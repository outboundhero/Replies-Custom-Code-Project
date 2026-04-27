/**
 * GET /api/nurture
 *
 * Returns nurture-eligible candidates from two data sources:
 *   1. Replies (Scenarios 1 + 2) — bucket is determined by the safety
 *      classifier from the reply text itself, NOT by the original AI category.
 *   2. nurture_sequence_finished (Scenario 3) — synced from EmailBison.
 *
 * 45-day eligibility is computed in SQL via reply_time / sequence_finished_at
 * comparisons against (now - 45d).
 *
 * Query params:
 *   source       "soft_negative" | "out_of_office" | "sequence_finished" | "all"  (default all)
 *   client_tag   filter by client
 *   status       "waiting" | "eligible" | "added" | "skipped" | "all"            (default all)
 *   safety       "safe" | "unsafe" | "unknown" | "unclassified" | "all"          (default all; n/a for sequence_finished)
 *   limit        page size (default 50, max 200)
 *   offset       pagination offset (default 0)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import supabase from "@/lib/supabase";

const NURTURE_DAYS = 45;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * AI categories that should NEVER appear in the nurture queue, regardless of
 * the nurture-safety classifier. Mirrors HARD_BLOCK_AI_CATEGORIES in
 * lib/nurture/safety-classifier.ts.
 */
const EXCLUDED_AI_CATEGORIES = [
  "Do Not Contact",
  "Wrong Person",
  "Wrong Person (Change of Target)",
  "Not Interested",
  "Mailbox No Longer Active",
  "Automated Error Message",
];

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
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(req.nextUrl.searchParams.get("limit") || DEFAULT_LIMIT))
    );
    const offset = Math.max(0, Number(req.nextUrl.searchParams.get("offset") || 0));

    const items: NurtureItem[] = [];
    const now = new Date();
    const cutoffIso = new Date(now.getTime() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Decide which sources to query.
    // sequence_finished only includes the seq table; soft_negative / out_of_office
    // restrict the replies-bucket filter; "all" hits both tables.
    const wantReplies =
      sourceParam === "all" ||
      sourceParam === "soft_negative" ||
      sourceParam === "out_of_office";
    const wantSeq = sourceParam === "all" || sourceParam === "sequence_finished";

    // ── Replies-based candidates ──
    if (wantReplies) {
      let q = supabase
        .from("replies")
        .select(
          "id, reply_id, client_tag, lead_email, first_name, last_name, company_name, ai_categorized_lead_category, reply_we_got, reply_time, nurture_safety, nurture_bucket, nurture_safety_reason, nurture_classified_at, nurture_added_at, nurture_skipped"
        )
        .not("reply_we_got", "is", null)
        .neq("reply_we_got", "")
        .not("reply_time", "is", null)
        // Exclude AI-categorized hard blocks (DNC, Wrong Person, etc.) so they
        // never reach the nurture queue, even if unclassified by the safety
        // classifier yet.
        .or(
          `ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`
        )
        .order("reply_time", { ascending: false });

      if (clientTag) q = q.eq("client_tag", clientTag);

      // bucket source filter
      if (sourceParam === "soft_negative") q = q.eq("nurture_bucket", "soft_negative");
      else if (sourceParam === "out_of_office") q = q.eq("nurture_bucket", "out_of_office");

      // status filter
      if (statusFilter === "added") {
        q = q.not("nurture_added_at", "is", null);
      } else if (statusFilter === "skipped") {
        q = q.eq("nurture_skipped", true);
      } else if (statusFilter === "eligible") {
        q = q
          .lte("reply_time", cutoffIso)
          .is("nurture_added_at", null)
          .or("nurture_skipped.is.null,nurture_skipped.eq.false");
      } else if (statusFilter === "waiting") {
        q = q
          .gt("reply_time", cutoffIso)
          .is("nurture_added_at", null)
          .or("nurture_skipped.is.null,nurture_skipped.eq.false");
      }

      // safety filter
      if (safetyFilter === "unclassified") {
        q = q.is("nurture_safety", null);
      } else if (safetyFilter === "safe" || safetyFilter === "unsafe" || safetyFilter === "unknown") {
        q = q.eq("nurture_safety", safetyFilter);
      }

      q = q.range(offset, offset + limit - 1);
      const { data: rows, error } = await q;
      if (error) throw new Error(error.message);

      for (const r of rows || []) {
        if (!r.reply_time) continue;
        let source: NurtureItem["source"];
        if (r.nurture_bucket === "out_of_office") source = "out_of_office";
        else if (r.nurture_bucket === "soft_negative") source = "soft_negative";
        else source = "other";

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

    // ── Sequence-finished candidates ──
    if (wantSeq) {
      let q = supabase
        .from("nurture_sequence_finished")
        .select(
          "id, ob_lead_id, ob_campaign_id, campaign_name, client_tag, email, first_name, last_name, company, sequence_finished_at, added_at, skipped"
        )
        .order("sequence_finished_at", { ascending: false });

      if (clientTag) q = q.eq("client_tag", clientTag);

      if (statusFilter === "added") {
        q = q.not("added_at", "is", null);
      } else if (statusFilter === "skipped") {
        q = q.eq("skipped", true);
      } else if (statusFilter === "eligible") {
        q = q
          .lte("sequence_finished_at", cutoffIso)
          .is("added_at", null)
          .or("skipped.is.null,skipped.eq.false");
      } else if (statusFilter === "waiting") {
        q = q
          .gt("sequence_finished_at", cutoffIso)
          .is("added_at", null)
          .or("skipped.is.null,skipped.eq.false");
      }

      q = q.range(offset, offset + limit - 1);
      const { data: seqRows, error } = await q;
      if (error) throw new Error(error.message);

      for (const r of seqRows || []) {
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

    // Sort the merged page by trigger_at desc so the two sources interleave correctly.
    items.sort((a, b) => (a.trigger_at < b.trigger_at ? 1 : -1));

    // Trim to page size in case both sources contributed.
    const paged = items.slice(0, limit);

    return NextResponse.json({
      items: paged,
      page: { limit, offset, returned: paged.length, hasMore: items.length === limit },
    });
  } catch (error) {
    console.error("[api/nurture] GET failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
