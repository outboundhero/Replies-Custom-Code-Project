/**
 * Map a recipient email to a routing bucket for the nurture campaigns.
 *
 *   "google"  → push to the client's Google nurture campaign. Default
 *               catch-all: Gmail, Google Workspace, custom MX domains
 *               (anything that isn't explicitly Outlook or a known SEG).
 *   "outlook" → push to the client's Outlook nurture campaign. Microsoft-
 *               hosted: Outlook.com, Hotmail, Office 365 tenant on a
 *               custom domain, on-prem Exchange.
 *   "segs"    → push to the client's SEGs nurture campaign. Security email
 *               gateways: Mimecast, Barracuda, Proofpoint, Cisco IronPort,
 *               Fortinet/FortiMail, Sophos, Trend Micro.
 *
 * The accurate signal is the recipient's actual mailbox provider, which
 * for custom B2B domains requires an MX lookup. We use EmailGuard for
 * that — see lib/email-guard.ts. The provider name is stored on the row
 * (replies.esp / nurture_legacy_leads.esp / nurture_sequence_finished.esp)
 * by the backfill script and the inbound webhook handler. This module
 * just maps the stored string to the routing bucket.
 *
 * The legacy heuristic (consumer-domain set) is kept as a last-resort
 * fallback for rows that don't yet have a stored ESP — better-than-
 * nothing while the backfill catches up.
 */

export type Esp = "google" | "outlook" | "segs";

// Substring matched against EmailGuard's email_host response (lowercased).
const OUTLOOK_HOST_KEYWORDS = [
  "outlook", "office 365", "office365", "microsoft", "exchange", "hotmail",
];
const SEG_HOST_KEYWORDS = [
  "mimecast", "barracuda", "proofpoint", "cisco", "ironport",
  "fortinet", "fortimail", "sophos", "trend micro",
];

/**
 * Bucket a stored email_host string from EmailGuard into one of the three
 * routing buckets.
 *
 * Precedence:
 *   1. Outlook keyword match → "outlook"
 *   2. SEG keyword match     → "segs"
 *   3. Everything else       → "google" (this is the catch-all — includes
 *      Gmail, Google Workspace, generic custom MX, null/unknown)
 *
 * Order matters: Outlook tenants sometimes route through a SEG (mailbox
 * is Office 365 but the SEG is what answers the MX). When EmailGuard
 * returns both, we treat as Outlook since that's the actual mailbox.
 */
export function bucketEsp(rawHost: string | null | undefined): Esp {
  if (!rawHost) return "google";
  const lower = rawHost.toLowerCase().trim();
  // Canonical bucket strings round-trip to themselves. The sync stores the
  // ESP derived from the source campaign name (detectCampaignEsp) as one
  // of these three values; without this short-circuit, "segs" would fall
  // through to the catch-all and mis-route to google (the SEG keyword list
  // below only matches gateway vendor names like mimecast/proofpoint).
  if (lower === "google" || lower === "outlook" || lower === "segs") return lower as Esp;
  for (const kw of OUTLOOK_HOST_KEYWORDS) {
    if (lower.includes(kw)) return "outlook";
  }
  for (const kw of SEG_HOST_KEYWORDS) {
    if (lower.includes(kw)) return "segs";
  }
  return "google";
}

/**
 * Fallback heuristic when no stored ESP is available — recognises only
 * the consumer Microsoft domains. Everything else returns "google" as
 * the safe default. Use bucketEsp(stored host) wherever possible; this
 * is just for rows the backfill hasn't reached yet.
 */
const OUTLOOK_FALLBACK_DOMAINS = new Set([
  "outlook.com", "hotmail.com", "live.com", "msn.com", "passport.com",
  "outlook.co.uk", "hotmail.co.uk", "live.co.uk",
  "outlook.fr", "hotmail.fr", "live.fr",
  "outlook.de", "hotmail.de", "live.de",
  "outlook.it", "hotmail.it",
  "outlook.es", "hotmail.es",
  "outlook.com.au", "hotmail.com.au",
  "outlook.jp",
  "microsoft.com", "office.com",
]);

export function detectEsp(email: string | null | undefined): Esp {
  if (!email) return "google";
  const at = email.lastIndexOf("@");
  if (at < 0) return "google";
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return "google";
  return OUTLOOK_FALLBACK_DOMAINS.has(domain) ? "outlook" : "google";
}

/**
 * Pick the best ESP signal: stored host (accurate, MX-derived) if present,
 * otherwise the consumer-domain heuristic.
 */
export function effectiveEsp(storedHost: string | null | undefined, email: string | null | undefined): Esp {
  if (storedHost) return bucketEsp(storedHost);
  return detectEsp(email);
}

export const ESP_LABEL: Record<Esp, string> = {
  google: "Google",
  outlook: "Outlook",
  segs: "SEGs",
};

/**
 * True when this is the CANONICAL nurture campaign for a client+ESP —
 * the one auto-routing is allowed to push into.
 *
 * Per client (Nick, confirmed in chat 2026-06-09): each client has
 * exactly three canonical nurture campaigns, one per ESP, all named
 * like:
 *   "JPNNJ: Google [Nurture] (Cleaning Client)"
 *   "JPNNJ: Outlook [Nurture] (Cleaning Client)"
 *   "JPNNJ: SEGs [Nurture] (Cleaning Client)"
 *
 * Legacy variants (e.g. "JPNNJ: Outlook (Nurture) (2)") still exist in
 * Bison but auto-route must ignore them — the marker is the literal
 * "(Cleaning Client)" suffix. Operators can still pick a legacy
 * campaign via the manual dropdown if they need to.
 */
export function isCanonicalNurtureCampaign(name: string): boolean {
  // Must be BOTH a [Nurture] campaign AND carry the "(Cleaning Client)" marker.
  // Requiring only "(Cleaning Client)" was too loose — it also matched the
  // SOURCE campaigns (e.g. "SBCC: Outlook (Cleaning Client)") and legacy
  // parenthetical "(Nurture)" variants, so auto-route could target the wrong
  // campaign. The canonical nurture campaigns are named exactly like
  // "JPNNJ: Outlook [Nurture] (Cleaning Client)".
  return /\[nurture\]/i.test(name) && /\(cleaning client\)/i.test(name);
}

/**
 * Bison's built-in mailbox-provider tags. These are `default: true`
 * system tags emitted on every lead. Source of truth verified via
 * GET /api/tags on outboundhero (2026-06-10) — 7 tags total. Same
 * tag names appear across every Bison workspace; only the numeric IDs
 * vary per workspace, so we match by NAME (case-insensitive exact).
 *
 * Three OTHER default tags exist that are NOT ESP signals — Interested,
 * Meeting Booked, Automated Reply. The allowlist below specifically
 * excludes them so they can't be mistaken for an ESP.
 *
 * If Bison ever adds a new ESP tag (e.g. Yandex), the lead falls
 * through to "Custom Mail Server" → google bucket via Bison itself,
 * so no code change is strictly required — but adding the name here
 * lets us store the precise value.
 */
const BISON_ESP_TAG_NAMES = new Set<string>([
  "google",
  "outlook",
  "zoho",
  "custom mail server",
  "proofpoint",
  "mimecast",
  "barracuda",
]);

/**
 * Pick the ESP tag from a lead's possibly-multi-tag array.
 *
 * Returns the matching Bison ESP tag with the HIGHEST routing precedence,
 * or null if the lead has no ESP tag at all (rare — Bison stamps every
 * lead with one of the 7 default ESP tags). Operator-added segmentation
 * tags like "Hot Lead" or "California List" are correctly ignored.
 *
 * Multi-ESP leads (e.g. a Microsoft tenant behind a Proofpoint/Mimecast
 * gateway, tagged BOTH `Outlook` AND `Proofpoint`) MUST resolve to the
 * mailbox provider, not the gateway. The old version returned the first
 * tag in Bison's array order — and that order is NOT stable, so some
 * Outlook-behind-a-SEG leads got stored as the SEG tag and leaked into
 * the SEGs nurture campaign. We now apply the same precedence bucketEsp()
 * uses — Outlook (the actual mailbox) > SEG gateway > everything else —
 * so routing matches the lead's true mailbox and Bison's primary tag.
 */
export function pickEspFromTags(
  tags: Array<{ id?: number; name?: string; default?: boolean }> | null | undefined,
): string | null {
  if (!tags || tags.length === 0) return null;
  const matches: string[] = [];
  for (const t of tags) {
    const name = (t.name || "").trim();
    if (!name) continue;
    if (BISON_ESP_TAG_NAMES.has(name.toLowerCase())) matches.push(name);
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  // Rank by routing bucket: outlook (0) wins over segs (1) wins over the
  // google catch-all (2). Stable for ties (first-seen of the same rank).
  const rank = (name: string): number => {
    const b = bucketEsp(name);
    return b === "outlook" ? 0 : b === "segs" ? 1 : 2;
  };
  return matches.reduce((best, cur) => (rank(cur) < rank(best) ? cur : best));
}

/**
 * Match a campaign name to one of the three ESP buckets based on naming
 * convention. Returns null when the campaign isn't ESP-tagged.
 *
 * Conventions recognised (case-insensitive):
 *   "JPH: Google (...)" / "JPH: Gmail ..." / "Gmail + Others"  → "google"
 *   "JPH: Outlook (...)"                                       → "outlook"
 *   "JPH: SEGs (...)" / "JPH: SEG ..."                         → "segs"
 */
export function detectCampaignEsp(name: string): Esp | null {
  const lower = name.toLowerCase();
  // SEG check first — "Outlook" and "SEGs" can both appear in names like
  // "JPH: SEGs Outlook" if you ever rename oddly; SEGs is the more
  // specific signal so it wins.
  if (/\bseg(s)?\b/.test(lower)) return "segs";
  if (/\boutlook\b/.test(lower)) return "outlook";
  if (/\bgoogle\b/.test(lower)) return "google";
  if (/\bgmail\b/.test(lower)) return "google";
  if (/gmail\s*\+\s*others?/.test(lower)) return "google";
  return null;
}
