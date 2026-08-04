/**
 * Named inbox views — predefined filter combinations so operators can switch to
 * a curated lead list.
 *
 * A view is data-driven and read in ONE place each by the counts RPC params and
 * the leads query (`app/api/inbox/route.ts`) — changing a view here shifts
 * counts, leads, AND which sidebar buckets show, with no SQL redeploy.
 *
 *   • excludeNoise        → only rows with `inbox_is_noise = false` (bounce/auto-
 *                           reply junk hidden). Noise is precomputed at ingest
 *                           from `lib/inbox-noise.ts` and stored on the row.
 *   • aiCategoryAllowlist → the reply's `ai_categorized_lead_category` must be one
 *                           of these EXACT values (index-friendly; no ILIKE). This
 *                           is the eligibility filter — it decides which leads are
 *                           counted/shown, so AI-negative leads can't hide inside a
 *                           kept bucket like "Open Response".
 *   • hiddenLeadCategories→ sidebar `lead_category` buckets to HIDE (negatives).
 *                           Labels for the remaining buckets are kept as-is.
 */

export interface InboxView {
  id: string;
  label: string;
  description?: string;
  /** Only include rows where inbox_is_noise = false. */
  excludeNoise?: boolean;
  /** Reply's ai_categorized_lead_category must be one of these EXACT values. */
  aiCategoryAllowlist?: string[];
  /** lead_category buckets to hide from the sidebar (negatives). */
  hiddenLeadCategories?: string[];
  /** Force the view to a single client tag (overrides the client dropdown). */
  clientTag?: string;
  /** Client tags to EXCLUDE from this view (e.g. Base Clients hides OH, which
   *  has its own dedicated OutboundHero (Cherry) view). Applied as a narrowed
   *  allowlist so counts + leads + realtime all honor it. */
  excludeClientTags?: string[];
}

// Shared "Cherry" filter config, reused by Base Clients (Cherry) and any
// client-scoped Cherry view (e.g. OutboundHero (Cherry)).
// EXACT values from VALID_CATEGORIES in lib/processing/lead-categorizer.ts.
const CHERRY_AI_ALLOWLIST = [
  "Interested",
  "Meeting Request",
  "Follow Up at a Later Date",
  "Referral Given",
  "Internally Forwarded",
  "Unrecognizable by AI",
];
// Base Clients (Cherry) additionally drops "Referral Given" — those AI-suggested
// referral leads should NOT appear in the base view (they still show in Master
// Inbox and the per-client cherry views). Removing it from the eligibility
// allowlist hides them even when they're sitting in the Open Response bucket.
const BASE_CHERRY_AI_ALLOWLIST = CHERRY_AI_ALLOWLIST.filter((c) => c !== "Referral Given");
// Negative lead_category buckets hidden from the sidebar. Kept buckets:
// Open Response, Interested, Meeting Set, Meeting-Ready Lead, Follow Up,
// Referral Given, Internally Forwarded, Closed Won, Needs Review.
const CHERRY_HIDDEN = [
  "Not Interested",
  "Not Interested (Send Reply)",
  "Do Not Contact",
  "Out Of Office",
  "Wrong Person",
  "Lost",
  "Automated Reply",
  "Mailbox No Longer Active",
  "Change Of Target",
  "Unqualified (Cleaning)",
];

export const INBOX_VIEWS: InboxView[] = [
  {
    id: "all",
    label: "Master Inbox",
    description: "All leads in the inbox",
  },
  {
    id: "base-clients-cherry",
    label: "Base Clients (Cherry)",
    description: "Positive + unrecognizable leads; bounce/auto-reply noise, negative buckets and Referral Given hidden. OH + DM4PM excluded (they have their own cherry views).",
    excludeNoise: true,
    // No "Referral Given" — hides AI-suggested referral leads even in Open Response.
    aiCategoryAllowlist: BASE_CHERRY_AI_ALLOWLIST,
    // Also hide the Referral Given bucket (still visible in Master Inbox + the
    // per-client cherry views).
    hiddenLeadCategories: [...CHERRY_HIDDEN, "Referral Given"],
    // OH and DM4PM have their own dedicated cherry views — keep them out of here.
    excludeClientTags: ["OH", "DM4PM"],
  },
  {
    id: "outboundhero-cherry",
    label: "OutboundHero (Cherry)",
    description: "Base Clients (Cherry), restricted to the OH client tag",
    excludeNoise: true,
    aiCategoryAllowlist: CHERRY_AI_ALLOWLIST,
    hiddenLeadCategories: CHERRY_HIDDEN,
    clientTag: "OH",
  },
  {
    id: "dm4pm-cherry",
    label: "DM4PM (Cherry)",
    description: "Base Clients (Cherry), restricted to the DM4PM client tag",
    excludeNoise: true,
    aiCategoryAllowlist: CHERRY_AI_ALLOWLIST,
    hiddenLeadCategories: CHERRY_HIDDEN,
    clientTag: "DM4PM",
  },
];

export function getView(id: string | null | undefined): InboxView | null {
  if (!id) return null;
  return INBOX_VIEWS.find((v) => v.id === id) || null;
}

/**
 * The positive-engagement lead_category buckets, in priority order. Shared by
 * the inbox sidebar and the server bootstrap so both agree on which bucket to
 * auto-open first. Browser-safe (no server deps).
 */
export const POSITIVE_CATEGORIES = [
  "Interested",
  "Meeting Set",
  "Meeting-Ready Lead",
  "Follow Up",
  "Referral Given",
  "Internally Forwarded",
];

// Positive AI lead categories (`ai_categorized_lead_category` strings, distinct
// from the working `lead_category` values above). Used to decide when a reply
// should loop in the client's configured CC/BCC — gated on the AI category so a
// lead still sitting in the Open Response bucket but AI-classified positive
// (e.g. "Interested") still gets the client team CC'd.
export const POSITIVE_AI_CATEGORIES = [
  "Interested",
  "Meeting Request",
  "Follow Up at a Later Date",
  "Referral Given",
  "Internally Forwarded",
];

/**
 * Pick the first non-empty bucket to auto-expand: positives first, then Open
 * Response, then whatever else has rows. MUST match the client's auto-expand so
 * the server-prefetched leads land in the bucket the UI opens.
 */
export function pickFirstCategory(counts: Record<string, number>): string | null {
  const keys = Object.keys(counts);
  const order = [...POSITIVE_CATEGORIES, "Open Response", ...keys];
  return order.find((c) => (counts[c] || 0) > 0) ?? null;
}
