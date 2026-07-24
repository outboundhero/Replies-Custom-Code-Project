/**
 * Shared, browser-safe helpers for composing an outgoing reply — the reply-all
 * recipient logic (§7/§8) and the pre-set (Send Reply) templates (§15/§23).
 * Used by the inbox composer/preview and the Data View bulk-review queue so
 * both build identical recipients + drafts.
 *
 * MUST stay free of server-only imports (no @/lib/db, supabase, etc.) — it runs
 * in the browser bundle.
 */
import { POSITIVE_CATEGORIES } from "@/lib/inbox-views";
import { buildNotInterestedReply } from "@/lib/processing/not-interested-reply";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
export interface Recipient { name: string; email: string }

export const PRIMARY_CONTACT_CATEGORY = "Request for Primary Point of Contact (Send Reply)";
const PRIMARY_CONTACT_TEMPLATE =
  "Thank you, {FIRST_NAME}. I appreciate you letting me know. Would you be able to provide the email address of your primary contact at the property management company? I'm asking because I'd like to see if they are currently in the market for the services we provide.";

export function leadFirstName(d: Row): string {
  const first = (d.first_name && String(d.first_name).trim()) || "";
  if (first) return first;
  const name = String(d.lead_name || d.from_name || "").trim();
  return name ? name.split(/\s+/)[0] : "there";
}

export function isSendReplyCategory(cat: string): boolean {
  return /\(send reply\)/i.test(cat);
}

/** The pre-set draft a (Send Reply) category loads. Primary-contact gets its
 *  generic ask here; the scenario-specific version is generated server-side. */
export function sendReplyTemplateFor(category: string, d: Row): string {
  if (category === PRIMARY_CONTACT_CATEGORY) return PRIMARY_CONTACT_TEMPLATE.replaceAll("{FIRST_NAME}", leadFirstName(d));
  if (category === "Not Interested (Send Reply)") {
    return buildNotInterestedReply(String(d.lead_name || d.from_name || ""), String(d.sender_name || ""));
  }
  return String(d.our_reply || "");
}

function splitPairs(names?: string | null, emails?: string | null): Recipient[] {
  const es = String(emails || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ns = String(names || "").split(",").map((s) => s.trim());
  return es.map((email, i) => ({ name: ns[i] || "", email }));
}

/**
 * Reply-all recipients from the inbound thread (§7/§8):
 *   To  = the person who replied.
 *   CC  = everyone else on the thread (reply's other To + its CC) minus our
 *         sending account; plus the client-team CC for positive categories.
 *   BCC = the client-team BCC for positive categories.
 */
export function computeReplyRecipients(d: Row, category: string): {
  to: Recipient; cc: Recipient[]; bcc: Recipient[];
} {
  const norm = (e: string) => e.trim().toLowerCase();
  const ours = norm(String(d.sender_email || ""));
  const leadEmail = norm(String(d.from_email || d.lead_email || ""));
  const to: Recipient = { name: String(d.from_name || d.lead_name || ""), email: String(d.from_email || d.lead_email || "") };
  const positive = POSITIVE_CATEGORIES.includes(category);

  const seen = new Set<string>([ours, leadEmail].filter(Boolean));
  const cc: Recipient[] = [];
  const pushCc = (r: Recipient) => {
    const e = norm(r.email);
    if (!e || seen.has(e)) return;
    seen.add(e);
    cc.push({ name: r.name.trim(), email: r.email.trim() });
  };
  splitPairs(d.to_name, d.to_email).forEach(pushCc);
  splitPairs(d.prospect_cc_name, d.prospect_cc_email).forEach(pushCc);
  if (positive) {
    ([1, 2, 3, 4, 5, 6] as const).forEach((n) => {
      const email = String(d[`cc_email_${n}`] || "");
      if (email) pushCc({ name: String(d[`cc_name_${n}`] || ""), email });
    });
  }
  const bcc: Recipient[] = [];
  if (positive) {
    ([1, 2] as const).forEach((n) => {
      const email = String(d[`bcc_email_${n}`] || "");
      if (email) bcc.push({ name: String(d[`bcc_name_${n}`] || ""), email });
    });
  }
  return { to, cc: cc.slice(0, 6), bcc: bcc.slice(0, 2) };
}

/** Category → Tailwind dot color (shared palette). */
export const CAT_DOT: Record<string, string> = {
  "Interested": "bg-green-500", "Meeting Set": "bg-green-600", "Meeting-Ready Lead": "bg-green-600",
  "Follow Up": "bg-blue-500", "Not Interested": "bg-gray-400", "Do Not Contact": "bg-red-500",
  "Out Of Office": "bg-yellow-500", "Wrong Person": "bg-orange-500", "Change Of Target": "bg-orange-400",
  "Automated Reply": "bg-gray-400", "Mailbox No Longer Active": "bg-gray-400",
  "Open Response": "bg-purple-500", "Needs Review": "bg-purple-400",
  "Referral Given": "bg-blue-600", "Internally Forwarded": "bg-blue-600",
  "Closed Won": "bg-emerald-600", "Lost": "bg-gray-500",
};
