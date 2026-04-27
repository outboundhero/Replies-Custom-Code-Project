/**
 * GET /api/nurture/counts
 *
 * Fast count-only endpoint for the Nurture page header tiles.
 * Returns: total candidates, eligible, eligible+safe (actionable), waiting, added.
 *
 * Uses Supabase `head: true` count queries — no row data is returned, so the
 * payload is tiny and the round-trip is dominated by index seeks.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import supabase from "@/lib/supabase";

const NURTURE_DAYS = 45;

// Mirror of EXCLUDED_AI_CATEGORIES in /api/nurture/route.ts — keep in sync.
const EXCLUDED_AI_CATEGORIES = [
  "Do Not Contact",
  "Wrong Person",
  "Wrong Person (Change of Target)",
  "Not Interested",
  "Mailbox No Longer Active",
  "Automated Error Message",
];

// Mirror of NOISE_SENDER_PATTERNS in /api/nurture/route.ts — keep in sync.
const NOISE_SENDER_PATTERNS = [
  "%@public.govdelivery.com",
  "%@govdelivery.com",
  "%@mailchimpapp.com",
  "%@em.%",
  "%@bounce.%",
  "%@bounces.%",
  "noreply@%",
  "no-reply@%",
  "no_reply@%",
  "donotreply@%",
  "do-not-reply@%",
  "do_not_reply@%",
  "notifications@%",
  "notification@%",
  "newsletter@%",
  "mailer-daemon@%",
  "mailer@%",
  "postmaster@%",
  "jira@%",
  "help@%",
  "helpdesk@%",
  "tickets@%",
  "ticket@%",
  "support-noreply@%",
  "%@spiceworks.com",
  "%.spiceworks.com",
  "%@zendesk.com",
  "%@freshdesk.com",
  "survey@%",
  "surveys@%",
  "feedback@%",
];

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const clientTag = req.nextUrl.searchParams.get("client_tag");
    const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const baseReplies = () => {
      let q = supabase
        .from("replies")
        .select("id", { count: "exact", head: true })
        .not("reply_we_got", "is", null)
        .neq("reply_we_got", "")
        .not("reply_time", "is", null)
        .neq("client_tag", "N/A")
        .or(
          `ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`
        );
      for (const p of NOISE_SENDER_PATTERNS) {
        q = q.not("lead_email", "ilike", p);
      }
      if (clientTag) q = q.eq("client_tag", clientTag);
      return q;
    };

    const baseSeq = () => {
      let q = supabase.from("nurture_sequence_finished").select("id", { count: "exact", head: true });
      if (clientTag) q = q.eq("client_tag", clientTag);
      return q;
    };

    const baseLegacy = () => {
      let q = supabase
        .from("nurture_legacy_leads")
        .select("id", { count: "exact", head: true })
        .neq("client_tag", "N/A")
        .or(
          `original_ai_category.is.null,original_ai_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`
        );
      for (const p of NOISE_SENDER_PATTERNS) {
        q = q.not("lead_email", "ilike", p);
      }
      if (clientTag) q = q.eq("client_tag", clientTag);
      return q;
    };

    const runCount = async (q: ReturnType<typeof baseReplies> | ReturnType<typeof baseSeq> | ReturnType<typeof baseLegacy>) => {
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return count ?? 0;
    };

    const [
      replyTotal,
      replyEligible,
      replyEligibleSafe,
      replyWaiting,
      replyAdded,
      seqTotal,
      seqEligible,
      seqWaiting,
      seqAdded,
      legacyTotal,
      legacyEligible,
      legacyEligibleSafe,
      legacyWaiting,
      legacyAdded,
    ] = await Promise.all([
      runCount(baseReplies()),
      runCount(
        baseReplies()
          .lte("reply_time", cutoffIso)
          .is("nurture_added_at", null)
          .or("nurture_skipped.is.null,nurture_skipped.eq.false")
      ),
      runCount(
        baseReplies()
          .lte("reply_time", cutoffIso)
          .is("nurture_added_at", null)
          .or("nurture_skipped.is.null,nurture_skipped.eq.false")
          .eq("nurture_safety", "safe")
      ),
      runCount(
        baseReplies()
          .gt("reply_time", cutoffIso)
          .is("nurture_added_at", null)
          .or("nurture_skipped.is.null,nurture_skipped.eq.false")
      ),
      runCount(baseReplies().not("nurture_added_at", "is", null)),
      runCount(baseSeq()),
      runCount(
        baseSeq()
          .lte("sequence_finished_at", cutoffIso)
          .is("added_at", null)
          .or("skipped.is.null,skipped.eq.false")
      ),
      runCount(
        baseSeq()
          .gt("sequence_finished_at", cutoffIso)
          .is("added_at", null)
          .or("skipped.is.null,skipped.eq.false")
      ),
      runCount(baseSeq().not("added_at", "is", null)),
      runCount(baseLegacy()),
      runCount(
        baseLegacy()
          .lte("reply_at", cutoffIso)
          .is("nurture_added_at", null)
          .or("nurture_skipped.is.null,nurture_skipped.eq.false")
      ),
      runCount(
        baseLegacy()
          .lte("reply_at", cutoffIso)
          .is("nurture_added_at", null)
          .or("nurture_skipped.is.null,nurture_skipped.eq.false")
          .eq("nurture_safety", "safe")
      ),
      runCount(
        baseLegacy()
          .gt("reply_at", cutoffIso)
          .is("nurture_added_at", null)
          .or("nurture_skipped.is.null,nurture_skipped.eq.false")
      ),
      runCount(baseLegacy().not("nurture_added_at", "is", null)),
    ]);

    // NOTE: counts are per-source raw totals. The actual list dedupes by
    // (lead_email, client_tag) across replies + legacy, so the visible row
    // count may be lower than (replyX + seqX + legacyX) when leads exist
    // in both `replies` and `nurture_legacy_leads`. Computing a perfect
    // deduped count would require a full anti-join — out of scope for now.
    return NextResponse.json(
      {
        total: replyTotal + seqTotal + legacyTotal,
        eligible: replyEligible + seqEligible + legacyEligible,
        // Sequence-finished rows have no safety classifier — treat them as safe.
        eligibleSafe: replyEligibleSafe + seqEligible + legacyEligibleSafe,
        waiting: replyWaiting + seqWaiting + legacyWaiting,
        added: replyAdded + seqAdded + legacyAdded,
      },
      { headers: { "Cache-Control": "private, max-age=30" } }
    );
  } catch (error) {
    console.error("[api/nurture/counts] GET failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
