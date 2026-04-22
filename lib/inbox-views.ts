/**
 * Named inbox views — predefined filter combinations.
 * Each view applies a set of "does not contain" filters and category restrictions
 * so users can quickly switch to a curated lead list.
 */

export interface InboxView {
  id: string;
  label: string;
  description?: string;
  /** Substrings that reply_we_got must NOT contain (case-insensitive) */
  replyExcludes?: string[];
  /** Substrings that lead_email must NOT contain (case-insensitive) */
  leadEmailExcludes?: string[];
  /** Substrings that to_email must NOT contain (case-insensitive) */
  toEmailExcludes?: string[];
  /** Substrings that email_subject must NOT contain (case-insensitive) */
  emailSubjectExcludes?: string[];
  /**
   * AI-categorized lead category must match one of these.
   * Each rule is either { equals: "X" } (exact match) or { contains: "Y" } (substring).
   */
  aiCategoryAny?: Array<{ equals?: string; contains?: string }>;
}

export const INBOX_VIEWS: InboxView[] = [
  {
    id: "all",
    label: "All Leads",
    description: "All leads in the inbox",
  },
  {
    id: "base-clients-cherry",
    label: "Base Clients (Cherry)",
    description: "Curated qualified leads with bounce/auto-reply noise filtered out",
    replyExcludes: [
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
    leadEmailExcludes: [
      "inbox",
      "dmarc",
      "daemon",
      "postmaster",
      "alignable.com",
      "hyperscale1.site",
      "voltic",
    ],
    toEmailExcludes: ["inbox"],
    emailSubjectExcludes: ["OutboundHero Cold"],
    aiCategoryAny: [
      { equals: "Interested" },
      { equals: "Meeting Request" },
      { contains: "Follow Up" },
      { contains: "Unrecognizable" },
      { contains: "Referral Given" },
      { contains: "Quote" },
    ],
  },
];

export function getView(id: string | null | undefined): InboxView | null {
  if (!id) return null;
  return INBOX_VIEWS.find((v) => v.id === id) || null;
}
