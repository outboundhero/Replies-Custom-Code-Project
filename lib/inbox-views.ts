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
}

export const INBOX_VIEWS: InboxView[] = [
  {
    id: "all",
    label: "Master Inbox",
    description: "All leads in the inbox",
  },
  {
    id: "base-clients-cherry",
    label: "Base Clients (Cherry)",
    description: "Positive + unrecognizable leads, bounce/auto-reply noise and negative buckets hidden",
    excludeNoise: true,
    // EXACT values from VALID_CATEGORIES in lib/processing/lead-categorizer.ts.
    aiCategoryAllowlist: [
      "Interested",
      "Meeting Request",
      "Follow Up at a Later Date",
      "Referral Given",
      "Internally Forwarded",
      "Unrecognizable by AI",
    ],
    // Negative lead_category buckets hidden from the sidebar. Kept buckets:
    // Open Response, Interested, Meeting Set, Meeting-Ready Lead, Follow Up,
    // Referral Given, Internally Forwarded, Closed Won, Needs Review.
    hiddenLeadCategories: [
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
    ],
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
