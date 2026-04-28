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
import { effectiveEsp } from "@/lib/nurture/esp";

// Allow longer timeout — large legacy table can make page queries slow.
export const maxDuration = 60;

const NURTURE_DAYS = 45;
const DEFAULT_LIMIT = 50;
// Bumped from 200 → 2000 because bulk-select-and-show requires
// fetching the full set (up to 1000) of selected leads in one call.
// The default page size stays 50; only explicit overrides go higher.
const MAX_LIMIT = 2000;

/**
 * AI / Lead categories that should NEVER appear in the nurture queue.
 * Mirrors HARD_BLOCK_AI_CATEGORIES in lib/nurture/safety-classifier.ts.
 *
 * Two reasons: hot leads already in active conversation (Interested,
 * Meeting Request, Meeting Set), and hard opt-outs / dead mailboxes.
 */
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
];

/**
 * Sender email patterns we never want in the nurture queue. These are
 * automated newsletters / transactional senders / ticket systems that
 * aren't real human leads. Patterns are SQL ILIKE — `%` is a wildcard.
 */
const NOISE_SENDER_PATTERNS = [
  // Mass-email / newsletter platforms
  "%@public.govdelivery.com",
  "%@govdelivery.com",
  "%@mailchimpapp.com",
  "%@em.%",                        // mass-email subdomains (em.foo.com)
  "%@bounce.%",
  "%@bounces.%",
  // No-reply mailboxes
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
  // Ticket / helpdesk systems
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
  // Survey / feedback bots
  "survey@%",
  "surveys@%",
  "feedback@%",
];

/**
 * Reply-body markers that indicate the message is an automated ticket
 * confirmation, survey, or notification — not a real human reply.
 * Applied client-side after fetch (cheap, runs over the page-sized batch).
 */
const NOISE_BODY_MARKERS = [
  "reply above this line",
  "type your reply above",
  "this is a notification from",
  "this is an automated message",
  "this email was sent automatically",
  "do not reply to this email",
  "how did we do",                  // common survey opener
  "## reply",                       // markdown ticket markers
  "-- reply",
];

function isNoiseBody(reply: string | null | undefined): boolean {
  if (!reply) return false;
  const lower = reply.toLowerCase();
  return NOISE_BODY_MARKERS.some((m) => lower.includes(m));
}

function applyNoiseSenderFilter<T extends { not: (col: string, op: string, val: string) => T }>(q: T): T {
  let result = q;
  for (const p of NOISE_SENDER_PATTERNS) {
    result = result.not("lead_email", "ilike", p);
  }
  return result;
}

/**
 * Drop rows whose client_tag is "N/A" (or NULL). These can't be routed to
 * a client-specific nurture campaign so they're useless in the queue.
 * Note: .neq is NULL-aware in PostgREST — "X != 'N/A'" is NULL when X is
 * NULL, and PostgreSQL filters NULL out, which is what we want.
 */
function applyClientTagFilter<T extends { neq: (col: string, val: string) => T }>(q: T): T {
  return q.neq("client_tag", "N/A");
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));
}

interface NurtureItem {
  id: string;
  source: "soft_negative" | "out_of_office" | "sequence_finished" | "legacy_airtable" | "other";
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
  esp_host: string | null;          // raw EmailGuard string ("Outlook", "Gmail", "Office 365", etc.)
  esp_bucket: "outlook" | "other";  // routing bucket derived from esp_host (or fallback heuristic on email)
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

function dedupeKey(email: string | null | undefined, clientTag: string | null | undefined): string {
  return `${(email || "").toLowerCase().trim()}|${(clientTag || "").trim()}`;
}

/**
 * Sort key → SQL column for each source. eligibility maps to the source's
 * trigger-time column; for legacy/replies, larger reply_time = larger
 * days_until_eligible, so the direction can be passed through directly.
 */
type SortKey = "email" | "company" | "client" | "source" | "safety" | "eligibility";

const SORT_COLUMN: Record<SortKey, { replies: string; seq: string; legacy: string }> = {
  email:       { replies: "lead_email",     seq: "email",                  legacy: "lead_email" },
  company:     { replies: "company_name",   seq: "company",                legacy: "company" },
  client:      { replies: "client_tag",     seq: "client_tag",             legacy: "client_tag" },
  source:      { replies: "nurture_bucket", seq: "client_tag",             legacy: "nurture_bucket" },
  safety:      { replies: "nurture_safety", seq: "client_tag",             legacy: "nurture_safety" },
  eligibility: { replies: "reply_time",     seq: "sequence_finished_at",   legacy: "reply_at" },
};

function isSortKey(s: string | null): s is SortKey {
  return !!s && ["email", "company", "client", "source", "safety", "eligibility"].includes(s);
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const sourceParam = req.nextUrl.searchParams.get("source") || "all";
    const clientTag = req.nextUrl.searchParams.get("client_tag");
    const statusFilter = req.nextUrl.searchParams.get("status") || "all";
    const safetyFilter = req.nextUrl.searchParams.get("safety") || "all";
    const espFilter = (req.nextUrl.searchParams.get("esp") || "").toLowerCase(); // "outlook" | "other" | ""
    const sortParam = req.nextUrl.searchParams.get("sort");
    const sortKey: SortKey = isSortKey(sortParam) ? sortParam : "eligibility";
    const sortDir = req.nextUrl.searchParams.get("dir") === "desc" ? "desc" : "asc";
    const sortAsc = sortDir === "asc";
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
    const wantLegacy = sourceParam === "all" || sourceParam === "legacy_airtable";

    // ── Replies-based candidates ──
    if (wantReplies) {
      // For "added" view, sort by when they were added (newest first by default).
      // Otherwise honour the user-requested sort column + direction.
      const orderByAddedDesc = statusFilter === "added" && sortKey === "eligibility";

      let q = supabase
        .from("replies")
        .select(
          "id, reply_id, client_tag, lead_email, first_name, last_name, company_name, ai_categorized_lead_category, reply_we_got, reply_time, nurture_safety, nurture_bucket, nurture_safety_reason, nurture_classified_at, nurture_added_at, nurture_skipped, esp"
        )
        .not("reply_we_got", "is", null)
        .neq("reply_we_got", "")
        .not("reply_time", "is", null)
        // Exclude AI-categorized hard blocks (DNC, Wrong Person, etc.) so they
        // never reach the nurture queue, even if unclassified by the safety
        // classifier yet.
        .or(
          `ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`
        );

      // Strip out automated newsletter / no-reply senders.
      q = applyNoiseSenderFilter(q);
      // Drop rows with no real client tag — can't route them.
      q = applyClientTagFilter(q);

      q = orderByAddedDesc
        ? q.order("nurture_added_at", { ascending: false })
        : q.order(SORT_COLUMN[sortKey].replies, { ascending: sortAsc, nullsFirst: false });

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

      // Fetch 2x the requested limit so we can dedupe by email and still
      // hand back close to `limit` distinct leads on the page. When an
      // ESP filter is active we over-fetch much more aggressively because
      // Outlook is rare (~5-10% of B2B addresses) and the bucket check
      // happens in JS (it spans multiple stored host strings: Outlook,
      // Office 365, Hotmail, Exchange, Microsoft).
      const repliesFetch = espFilter ? Math.min(2000, limit * 20) : limit * 2;
      q = q.range(offset, offset + repliesFetch - 1);
      const { data: rows, error } = await q;
      if (error) throw new Error(error.message);

      // Dedupe by (lead_email, client_tag) — same person under the same
      // client tag collapses to one entry. The query is ordered by reply_time
      // so the first occurrence is the most relevant for the active view.
      const seenKeys = new Set<string>();
      for (const r of rows || []) {
        if (!r.reply_time) continue;
        const email = (r.lead_email || "").toLowerCase();
        if (!email) continue;
        const key = dedupeKey(email, r.client_tag);
        if (seenKeys.has(key)) continue;
        // Skip ticket / notification / survey auto-replies based on body markers.
        if (isNoiseBody(r.reply_we_got)) continue;
        seenKeys.add(key);

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
          esp_host: r.esp ?? null,
          esp_bucket: effectiveEsp(r.esp, r.lead_email),
          reply_id: r.reply_id,
          ai_category: r.ai_categorized_lead_category,
          reply_text: r.reply_we_got,
          nurture_safety: r.nurture_safety,
          nurture_bucket: r.nurture_bucket,
          nurture_safety_reason: r.nurture_safety_reason,
          nurture_classified_at: r.nurture_classified_at,
        });
        if (items.length >= limit) break;
      }
    }

    // ── Sequence-finished candidates ──
    if (wantSeq) {
      const seqOrderByAddedDesc = statusFilter === "added" && sortKey === "eligibility";
      let q = supabase
        .from("nurture_sequence_finished")
        .select(
          "id, ob_lead_id, ob_campaign_id, campaign_name, client_tag, email, first_name, last_name, company, sequence_finished_at, added_at, skipped, esp"
        );

      q = seqOrderByAddedDesc
        ? q.order("added_at", { ascending: false })
        : q.order(SORT_COLUMN[sortKey].seq, { ascending: sortAsc, nullsFirst: false });

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

      const seqFetch = espFilter ? Math.min(2000, limit * 20) : limit;
      q = q.range(offset, offset + seqFetch - 1);
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
          esp_host: r.esp ?? null,
          esp_bucket: effectiveEsp(r.esp, r.email),
          ob_lead_id: r.ob_lead_id,
          ob_campaign_id: r.ob_campaign_id,
          campaign_name: r.campaign_name || undefined,
        });
      }
    }

    // ── Legacy Airtable candidates (historical replies imported from Airtable) ──
    if (wantLegacy) {
      const legacyOrderByAddedDesc = statusFilter === "added" && sortKey === "eligibility";
      let q = supabase
        .from("nurture_legacy_leads")
        .select(
          "id, airtable_record_id, lead_email, first_name, last_name, company, client_tag, reply_text, reply_at, original_ai_category, nurture_safety, nurture_bucket, nurture_safety_reason, nurture_classified_at, nurture_added_at, nurture_skipped, esp"
        );

      q = legacyOrderByAddedDesc
        ? q.order("nurture_added_at", { ascending: false })
        : q.order(SORT_COLUMN[sortKey].legacy, { ascending: sortAsc, nullsFirst: false });

      // Same hard-block AI-category filter as the replies query
      q = q.or(
        `original_ai_category.is.null,original_ai_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`
      );

      // Same noise-sender filter as the replies query
      for (const p of NOISE_SENDER_PATTERNS) {
        q = q.not("lead_email", "ilike", p);
      }
      // Same client-tag filter — drop N/A.
      q = q.neq("client_tag", "N/A");

      if (clientTag) q = q.eq("client_tag", clientTag);

      if (statusFilter === "added") {
        q = q.not("nurture_added_at", "is", null);
      } else if (statusFilter === "skipped") {
        q = q.eq("nurture_skipped", true);
      } else if (statusFilter === "eligible") {
        q = q
          .lte("reply_at", cutoffIso)
          .is("nurture_added_at", null)
          .or("nurture_skipped.is.null,nurture_skipped.eq.false");
      } else if (statusFilter === "waiting") {
        q = q
          .gt("reply_at", cutoffIso)
          .is("nurture_added_at", null)
          .or("nurture_skipped.is.null,nurture_skipped.eq.false");
      }

      // Safety filter — same semantics as replies
      if (safetyFilter === "unclassified") {
        q = q.is("nurture_safety", null);
      } else if (safetyFilter === "safe" || safetyFilter === "unsafe" || safetyFilter === "unknown") {
        q = q.eq("nurture_safety", safetyFilter);
      }

      // Fetch 2x for dedupe headroom; over-fetch for ESP filter same as replies.
      const legacyFetch = espFilter ? Math.min(2000, limit * 20) : limit * 2;
      q = q.range(offset, offset + legacyFetch - 1);
      const { data: legacyRows, error } = await q;
      if (error) throw new Error(error.message);

      // Cross-source dedupe: skip any (email, client_tag) already seen in
      // `replies` above. Recent replies always win — they're more authoritative.
      const seenFromReplies = new Set<string>();
      for (const it of items) seenFromReplies.add(dedupeKey(it.email, it.client_tag));

      const seenLegacy = new Set<string>();
      for (const r of legacyRows || []) {
        if (!r.reply_at) continue;
        const email = (r.lead_email || "").toLowerCase();
        if (!email) continue;
        const key = dedupeKey(email, r.client_tag);
        if (seenFromReplies.has(key) || seenLegacy.has(key)) continue;
        if (isNoiseBody(r.reply_text)) continue;
        seenLegacy.add(key);

        let source: NurtureItem["source"];
        if (r.nurture_bucket === "out_of_office") source = "out_of_office";
        else if (r.nurture_bucket === "soft_negative") source = "soft_negative";
        else source = "legacy_airtable";

        const triggerAt = new Date(r.reply_at);
        const eligibleAt = new Date(triggerAt.getTime() + NURTURE_DAYS * 24 * 60 * 60 * 1000);
        const daysLeft = daysBetween(eligibleAt, now);
        const isEligible = daysLeft <= 0;

        items.push({
          id: `legacy:${r.id}`,
          source,
          client_tag: r.client_tag,
          email: r.lead_email,
          first_name: r.first_name,
          last_name: r.last_name,
          company: r.company,
          trigger_at: r.reply_at,
          eligible_at: eligibleAt.toISOString(),
          days_until_eligible: daysLeft,
          is_eligible: isEligible,
          added_at: r.nurture_added_at,
          skipped: !!r.nurture_skipped,
          esp_host: r.esp ?? null,
          esp_bucket: effectiveEsp(r.esp, r.lead_email),
          ai_category: r.original_ai_category,
          reply_text: r.reply_text,
          nurture_safety: r.nurture_safety,
          nurture_bucket: r.nurture_bucket,
          nurture_safety_reason: r.nurture_safety_reason,
          nurture_classified_at: r.nurture_classified_at,
        });
        if (items.length >= limit * 3) break;
      }
    }

    // Sort the merged page using the same key that was applied per-source,
    // so items from replies / seq / legacy interleave in the correct order.
    const SAFETY_RANK: Record<string, number> = { safe: 0, unknown: 1, unsafe: 2 };
    const cmpKey = (it: NurtureItem): string | number => {
      switch (sortKey) {
        case "email":       return it.email?.toLowerCase() || "~";
        case "company":     return it.company?.toLowerCase() || "~";
        case "client":      return it.client_tag?.toLowerCase() || "~";
        case "source":      return it.source;
        case "safety":      return it.source === "sequence_finished" ? 0 : SAFETY_RANK[it.nurture_safety || ""] ?? 3;
        case "eligibility": return it.trigger_at;
      }
    };
    const dir = sortAsc ? 1 : -1;
    items.sort((a, b) => {
      const av = cmpKey(a);
      const bv = cmpKey(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Tiebreak by trigger_at ascending — most-due first within ties.
      return a.trigger_at < b.trigger_at ? -1 : 1;
    });

    // ESP routing filter — applied AFTER per-row esp_bucket is computed.
    // Has to be JS-side because the bucket spans multiple stored host
    // strings (Outlook / Office 365 / Hotmail / Microsoft / Exchange).
    const espFiltered = espFilter
      ? items.filter((i) => i.esp_bucket === espFilter)
      : items;

    // Trim to page size in case multiple sources contributed.
    const paged = espFiltered.slice(0, limit);

    return NextResponse.json({
      items: paged,
      page: { limit, offset, returned: paged.length, hasMore: espFiltered.length === limit },
    });
  } catch (error) {
    console.error("[api/nurture] GET failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
