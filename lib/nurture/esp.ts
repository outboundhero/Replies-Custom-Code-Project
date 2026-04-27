/**
 * Map a recipient email to a routing bucket for the nurture campaigns.
 *
 *   "outlook" → push to the client's Outlook nurture campaign (any
 *               Microsoft-hosted mailbox: Outlook.com, Hotmail, Live,
 *               Office 365 tenant on a custom domain).
 *   "other"   → push to the client's Gmail + Others nurture campaign.
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

export type Esp = "outlook" | "other";

const OUTLOOK_HOST_KEYWORDS = [
  "outlook",
  "office 365",
  "office365",
  "microsoft",
  "exchange",
  "hotmail",
];

/**
 * Bucket a stored email_host string from EmailGuard into one of the two
 * routing buckets. Anything Microsoft-hosted goes to "outlook"; everything
 * else (Gmail, Yahoo, Zoho, Proton, custom, null/unknown) → "other".
 */
export function bucketEsp(rawHost: string | null | undefined): Esp {
  if (!rawHost) return "other";
  const lower = rawHost.toLowerCase();
  for (const kw of OUTLOOK_HOST_KEYWORDS) {
    if (lower.includes(kw)) return "outlook";
  }
  return "other";
}

/**
 * Fallback heuristic when no stored ESP is available — recognises only
 * the consumer Microsoft domains. Custom B2B domains return "other".
 * Use bucketEsp(stored host) wherever possible; this is just for rows
 * the backfill hasn't reached yet.
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
  if (!email) return "other";
  const at = email.lastIndexOf("@");
  if (at < 0) return "other";
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return "other";
  return OUTLOOK_FALLBACK_DOMAINS.has(domain) ? "outlook" : "other";
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
  outlook: "Outlook",
  other: "Gmail + Others",
};

/**
 * Match a campaign name to one of the two ESP buckets. Returns null when
 * the campaign isn't ESP-tagged in its name.
 */
export function detectCampaignEsp(name: string): Esp | null {
  const lower = name.toLowerCase();
  if (/\boutlook\b/.test(lower)) return "outlook";
  if (/\bgmail\b/.test(lower)) return "other";
  if (/gmail\s*\+\s*others?/.test(lower)) return "other";
  return null;
}
