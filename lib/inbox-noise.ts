/**
 * Single source of truth for inbox "noise" detection — bounce / auto-reply /
 * delivery-failure junk that the curated views (e.g. Base Clients / Cherry)
 * hide.
 *
 * Previously these substring lists lived inside the Cherry view config and were
 * ALSO duplicated as ~30 `NOT ILIKE '%term%'` clauses inside the counts SQL, and
 * both were evaluated over all 245k rows on every read → full scans + timeouts.
 *
 * Now the match runs ONCE at ingest and is stored in the indexed boolean column
 * `replies.inbox_is_noise`, so reads just filter `inbox_is_noise = false`.
 *
 * Pure + dependency-free so it's safe to import anywhere (ingest, client, tests).
 * The one-time backfill SQL in `sql/2026-07_inbox_is_noise.sql` mirrors these
 * exact terms — keep the two in sync (there aren't many and they rarely change).
 */

export const NOISE = {
  /** Substrings in the reply body that mark it as a bounce / auto-reply. */
  reply: [
    "could not be delivered",
    "DMARC",
    "Error message",
    "This is the mail system",
    "automated message",
    "I wasn't able to",
    "Failed to deliver",
    "Permanent fatal",
    "Permanent error",
    "couldn't be delivered",
    "delivery has failed",
    "temporary problem",
    "not delivered",
    "empty response",
    "please try again",
    "Error Type",
    "undeliverable",
    "address not found",
    "to postmaster",
    "message blocked",
    "Address not reachable",
    "Delivery Status Notification",
    "sah28aj19",
  ],
  /** Substrings in the sender address that mark it as a system mailbox. */
  leadEmail: ["inbox", "dmarc", "daemon", "postmaster", "alignable.com", "hyperscale1.site", "voltic"],
  /** Substrings in the recipient address. */
  toEmail: ["inbox"],
  /** Substrings in the subject. */
  subject: ["OutboundHero Cold"],
} as const;

function anyContains(haystack: string | null | undefined, needles: readonly string[]): boolean {
  if (!haystack) return false;
  const h = haystack.toLowerCase();
  for (const n of needles) if (h.includes(n.toLowerCase())) return true;
  return false;
}

/**
 * True if a reply row is bounce/auto-reply/system noise that curated views hide.
 * Matches the semantics of the old per-column `NOT ILIKE '%term%'` chain: a row
 * is noise if ANY term hits ANY of the four fields.
 */
export function isNoiseReply(row: {
  reply_we_got?: string | null;
  lead_email?: string | null;
  to_email?: string | null;
  email_subject?: string | null;
}): boolean {
  return (
    anyContains(row.reply_we_got, NOISE.reply) ||
    anyContains(row.lead_email, NOISE.leadEmail) ||
    anyContains(row.to_email, NOISE.toEmail) ||
    anyContains(row.email_subject, NOISE.subject)
  );
}
