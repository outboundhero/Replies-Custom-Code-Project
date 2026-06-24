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

// Counts can be expensive after large imports; default 10s is not enough.
export const maxDuration = 60;

const NURTURE_DAYS = 45;

// Mirror of EXCLUDED_AI_CATEGORIES in /api/nurture/route.ts — keep in sync.
const EXCLUDED_AI_CATEGORIES = [
  "Interested",
  "Meeting Request",
  "Meeting Set",
  "Do Not Contact",
  "Wrong Person",
  "Wrong Person (Change of Target)",
  "Not Interested",
  "Mailbox No Longer Active",
  "Automated Error Message",
  "Automated Catch-All Message",
  "Referral Given",
  "Internally Forwarded",
];

// Noise-sender patterns are intentionally NOT filtered in this counts
// endpoint — see comment in baseReplies() / baseLegacy(). They live in
// /api/nurture for the list query.

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const clientTag = req.nextUrl.searchParams.get("client_tag");
    const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Per-client tiles are ALWAYS computed LIVE (operators act on these numbers
    // the instant they push leads — a stale cache would mislead). The 14 exact
    // COUNTs below run in parallel and, with the client_tag indexes + fresh
    // ANALYZE, complete in ~1.6s for the largest client and far less for most.
    // (A single-client UNION-ALL RPC was tried and is SLOWER here — it scans
    // every client row + evaluates CASEs, whereas separate COUNTs use indexes.)

    // NOTE: counts intentionally omit the noise-sender ILIKE patterns. With
    // 30+ patterns × 394K legacy rows, those scans hit Supabase's statement
    // timeout (~8s) and the count returns an empty error. The list query
    // (/api/nurture) keeps the full filter — only 50 rows go through it per
    // request, so it's fine. Result: tile counts may overcount by a few
    // percent (a handful of newsletter senders), which is fine for a header
    // tile. The list itself is always accurate.
    // Per-client view: use "exact" so the tile matches the hub's RPC
    // aggregate. The whole-table view (no clientTag) stays on "estimated"
    // because exact counts on 394k legacy + 11M reply rows would blow
    // the Supabase statement-timeout budget. The client_tag-filtered
    // counts are fast under the existing tag indexes.
    const countMode: "exact" | "estimated" = clientTag ? "exact" : "estimated";

    const baseReplies = () => {
      let q = supabase
        .from("replies")
        .select("id", { count: countMode, head: true })
        .not("reply_we_got", "is", null)
        .neq("reply_we_got", "")
        .not("reply_time", "is", null)
        .neq("client_tag", "N/A")
        .or(
          `ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`
        );
      if (clientTag) q = q.eq("client_tag", clientTag);
      return q;
    };

    const baseSeq = () => {
      let q = supabase.from("nurture_sequence_finished").select("id", { count: countMode, head: true });
      if (clientTag) q = q.eq("client_tag", clientTag);
      return q;
    };

    const baseLegacy = () => {
      let q = supabase
        .from("nurture_legacy_leads")
        .select("id", { count: countMode, head: true })
        .neq("client_tag", "N/A")
        .or(
          `original_ai_category.is.null,original_ai_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`
        );
      if (clientTag) q = q.eq("client_tag", clientTag);
      return q;
    };

    /**
     * Run one count query. On failure (timeout, syntax, etc.) log the FULL
     * error and return 0 so a single bad query doesn't blank the entire
     * tile row. Empty error.message from PostgREST is common for
     * statement-timeout errors — log the whole object so we can see code,
     * details, hint.
     */
    const runCount = async (
      label: string,
      q: ReturnType<typeof baseReplies> | ReturnType<typeof baseSeq> | ReturnType<typeof baseLegacy>
    ): Promise<number> => {
      try {
        const { count, error } = await q;
        if (error) {
          console.error(`[counts:${label}] Supabase error:`, JSON.stringify(error));
          return 0;
        }
        return count ?? 0;
      } catch (e) {
        console.error(`[counts:${label}] threw:`, e);
        return 0;
      }
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
      runCount("replies.total", baseReplies()),
      runCount(
        "replies.eligible",
        baseReplies()
          .lte("reply_time", cutoffIso)
          .is("nurture_added_at", null)
          .not("nurture_skipped", "is", true)
      ),
      runCount(
        "replies.eligibleSafe",
        baseReplies()
          .lte("reply_time", cutoffIso)
          .is("nurture_added_at", null)
          .not("nurture_skipped", "is", true)
          .eq("nurture_safety", "safe")
      ),
      runCount(
        "replies.waiting",
        baseReplies()
          .gt("reply_time", cutoffIso)
          .is("nurture_added_at", null)
          .not("nurture_skipped", "is", true)
      ),
      runCount("replies.added", baseReplies().not("nurture_added_at", "is", null)),
      runCount("seq.total", baseSeq()),
      runCount(
        "seq.eligible",
        baseSeq()
          .lte("sequence_finished_at", cutoffIso)
          .is("added_at", null)
          .not("skipped", "is", true)
      ),
      runCount(
        "seq.waiting",
        baseSeq()
          .gt("sequence_finished_at", cutoffIso)
          .is("added_at", null)
          .not("skipped", "is", true)
      ),
      runCount("seq.added", baseSeq().not("added_at", "is", null)),
      runCount("legacy.total", baseLegacy()),
      runCount(
        "legacy.eligible",
        baseLegacy()
          .lte("reply_at", cutoffIso)
          .is("nurture_added_at", null)
          .not("nurture_skipped", "is", true)
      ),
      runCount(
        "legacy.eligibleSafe",
        baseLegacy()
          .lte("reply_at", cutoffIso)
          .is("nurture_added_at", null)
          .not("nurture_skipped", "is", true)
          .eq("nurture_safety", "safe")
      ),
      runCount(
        "legacy.waiting",
        baseLegacy()
          .gt("reply_at", cutoffIso)
          .is("nurture_added_at", null)
          .not("nurture_skipped", "is", true)
      ),
      runCount("legacy.added", baseLegacy().not("nurture_added_at", "is", null)),
    ]);

    // NOTE: counts are per-source raw totals. The actual list dedupes by
    // (lead_email, client_tag) across replies + legacy, so the visible row
    // count may be lower than (replyX + seqX + legacyX) when leads exist
    // in both `replies` and `nurture_legacy_leads`.

    // "Added" = leads actually pushed to a campaign. The per-source COUNT(*)s
    // over-count because one lead can have several sequence-finished rows (one
    // per finished sequence). Bison holds one lead per email, so the accurate
    // tile is the DISTINCT-email count across the added sources. We get that
    // from an RPC for the per-client view; if the RPC isn't deployed yet, fall
    // back to the raw row sum so the tile never blanks.
    const rawAdded = replyAdded + seqAdded + legacyAdded;
    let added = rawAdded;
    if (clientTag) {
      try {
        const { data, error } = await supabase.rpc("nurture_added_distinct", { tag: clientTag });
        if (!error && data != null) added = Number(data) || 0;
        else if (error) console.error("[counts:added.distinct] rpc error:", JSON.stringify(error));
      } catch (e) {
        console.error("[counts:added.distinct] threw:", e);
      }
    }

    return NextResponse.json(
      {
        total: replyTotal + seqTotal + legacyTotal,
        eligible: replyEligible + seqEligible + legacyEligible,
        // Sequence-finished rows have no safety classifier — treat them as safe.
        eligibleSafe: replyEligibleSafe + seqEligible + legacyEligibleSafe,
        waiting: replyWaiting + seqWaiting + legacyWaiting,
        added,
      },
      { headers: { "Cache-Control": "private, max-age=30" } }
    );
  } catch (error) {
    console.error("[api/nurture/counts] GET failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
