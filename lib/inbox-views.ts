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
  /** Restrict the view to this SET of client tags (e.g. CWSJ (Cherry) shows only
   *  CWSJ + CWSJ-OS). Use when a dedicated team owns MORE THAN ONE tag — clientTag
   *  handles the single-tag case. Applied as a narrowed allowlist so counts +
   *  leads + dropdown all honor it (and still intersected with per-user scoping). */
  includeClientTags?: string[];
  /** Client tags to EXCLUDE from this view (e.g. Base Clients hides OH, which
   *  has its own dedicated OutboundHero (Cherry) view). Applied as a narrowed
   *  allowlist so counts + leads + realtime all honor it. */
  excludeClientTags?: string[];
  /** Only rows currently in a DM4PM subsequence (dm4pm_subseq_status set). The
   *  server forces the slow-path counts for this so the sidebar stays accurate. */
  subsequenceOnly?: boolean;
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
    // OH, DM4PM and SBSPO have their own dedicated cherry views + logins — keep
    // them out of the regular team's base view so work doesn't overlap. CWSJ /
    // CWSJ-OS are worked by the regular inbox team now, so they stay INCLUDED
    // here (they still also have their own CWSJ (Cherry) view).
    excludeClientTags: ["OH", "DM4PM", "SBSPO"],
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
  {
    id: "dm4pm-subsequence",
    label: "DM4PM Subsequence",
    description: "DM4PM leads currently in the interested-reply follow-up subsequence (active, paused, snoozed, or completed).",
    clientTag: "DM4PM",
    subsequenceOnly: true,
  },
  {
    id: "oh-subsequence",
    label: "OH Subsequence",
    description: "OutboundHero leads currently in the interested-reply follow-up subsequence (active, paused, snoozed, or completed).",
    clientTag: "OH",
    subsequenceOnly: true,
  },
  {
    id: "cwsj-cherry",
    label: "CWSJ & CWSJ-OS (Cherry)",
    description: "Base Clients (Cherry), restricted to the CWSJ + CWSJ-OS client tags (their own team owns both).",
    excludeNoise: true,
    aiCategoryAllowlist: CHERRY_AI_ALLOWLIST,
    hiddenLeadCategories: CHERRY_HIDDEN,
    includeClientTags: ["CWSJ", "CWSJ-OS"],
  },
  {
    id: "sbspo-cherry",
    label: "SBSPO (Cherry)",
    description: "Base Clients (Cherry), restricted to the SBSPO client tag",
    excludeNoise: true,
    aiCategoryAllowlist: CHERRY_AI_ALLOWLIST,
    hiddenLeadCategories: CHERRY_HIDDEN,
    clientTag: "SBSPO",
  },
  {
    id: "sbspo-all",
    label: "SBSPO Master Inbox",
    description: "All SBSPO leads (every bucket + noise), restricted to the SBSPO client tag.",
    clientTag: "SBSPO",
  },
];

export function getView(id: string | null | undefined): InboxView | null {
  if (!id) return null;
  return INBOX_VIEWS.find((v) => v.id === id) || null;
}

/**
 * The id of a dedicated NON-cherry master view (e.g. "SBSPO Master Inbox") that
 * covers a scoped user's FULL tag scope, or null if none. Used to (a) hide the
 * generic "Master Inbox" duplicate for that user and (b) pick their default view.
 * A client whose scope has no such view (e.g. CWSJ) returns null → keeps generic.
 */
export function dedicatedMasterViewId(allowedClientTags?: string[] | null): string | null {
  if (!allowedClientTags || !allowedClientTags.length) return null;
  const v = INBOX_VIEWS.find((vv) => {
    if (vv.id === "all" || vv.aiCategoryAllowlist?.length) return false; // must be a non-cherry master
    const tags = vv.clientTag ? [vv.clientTag] : vv.includeClientTags ?? [];
    return tags.length > 0 && allowedClientTags.every((t) => tags.includes(t));
  });
  return v?.id ?? null;
}

/** True when {@link dedicatedMasterViewId} exists for this scope. */
export function hasDedicatedMasterView(allowedClientTags?: string[] | null): boolean {
  return dedicatedMasterViewId(allowedClientTags) !== null;
}

/**
 * Does a reply row belong in `view`? The SINGLE source of truth for view
 * membership, mirroring the server-side query (client tag scope + include/exclude,
 * noise, AI allowlist, hidden buckets). The realtime INSERT handler MUST use this
 * so a new reply can never leak into a view the server would have filtered out
 * (e.g. a non-OH reply appearing in the OutboundHero (Cherry) view). Browser-safe.
 */
export function replyMatchesView(
  view: InboxView | null,
  row: {
    client_tag?: string | null;
    inbox_is_noise?: boolean | null;
    ai_categorized_lead_category?: string | null;
    lead_category?: string | null;
    dm4pm_subseq_status?: string | null;
  },
  allowedClientTags?: string[] | null,
): boolean {
  const tag = row.client_tag || "";
  // Per-user hard scope (a scoped user never sees other clients' rows).
  if (allowedClientTags && allowedClientTags.length && !allowedClientTags.includes(tag)) return false;
  if (!view) return true;
  // Subsequence view: only rows currently carrying a subsequence status.
  if (view.subsequenceOnly && !row.dm4pm_subseq_status) return false;
  // Client-tag restriction — single tag (OutboundHero/DM4PM Cherry) or a set
  // (CWSJ Cherry), and exclusions (Base Clients Cherry). This is what was missing
  // from the realtime path and let other clients' replies leak into a scoped view.
  if (view.clientTag && tag !== view.clientTag) return false;
  if (view.includeClientTags?.length && !view.includeClientTags.includes(tag)) return false;
  if (view.excludeClientTags?.length && view.excludeClientTags.includes(tag)) return false;
  // Noise / AI eligibility / hidden buckets.
  if (view.excludeNoise && row.inbox_is_noise) return false;
  if (view.aiCategoryAllowlist?.length &&
      !view.aiCategoryAllowlist.includes(row.ai_categorized_lead_category || "")) return false;
  const cat = row.lead_category || "Open Response";
  if (view.hiddenLeadCategories?.includes(cat)) return false;
  return true;
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
