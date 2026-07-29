/**
 * Build the full conversation for a reply, oldest-first:
 *   [initial campaign cold email (tracked only)] → older_messages → current_reply
 *   → newer_messages.
 *
 * Combines two Bison endpoints:
 *   - GET /api/replies/{id}/conversation-thread  (all threaded messages; works
 *     for tracked AND untracked)
 *   - getFirstSentEmail(leadId, campaignId)      (the original cold email — the
 *     one thing the thread endpoint omits; tracked only)
 *
 * Used to (a) render the inbox email history and (b) feed complete conversation
 * context to Generate Reply + the audit so they never repeat questions/info.
 */
import {
  getReplyConversationThread, getFirstSentEmail, type ConversationThreadMessage,
} from "@/lib/outboundhero-api";

export interface ThreadEntry {
  direction: "sent" | "received";
  at: string;        // ISO timestamp (may be "")
  subject: string;
  body: string;      // plain text
  sender: string;    // from name or email
}

/** Cheap HTML → text: keep line breaks, drop tags, decode common entities. */
export function htmlToText(s: string): string {
  return String(s || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&#39;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function directionOf(m: ConversationThreadMessage, leadEmail: string): "sent" | "received" {
  const from = (m.from_email_address || "").trim().toLowerCase();
  if (m.folder && /sent/i.test(m.folder)) return "sent";
  if (from && leadEmail && from === leadEmail) return "received";
  if (m.folder && /inbox/i.test(m.folder)) return "received";
  // Fallback: an inbound reply type is received; anything else is ours.
  return m.type && /reply/i.test(m.type) ? "received" : "sent";
}

export async function buildConversationThread(opts: {
  instance: string;
  replyId: number;
  leadId?: number | null;
  campaignId?: number | null;
  leadEmail?: string | null;
}): Promise<ThreadEntry[]> {
  const { instance, replyId, leadId, campaignId, leadEmail } = opts;
  const lead = (leadEmail || "").trim().toLowerCase();
  const entries: ThreadEntry[] = [];

  // Threaded messages (tracked + untracked).
  let msgs: ConversationThreadMessage[] = [];
  try { msgs = await getReplyConversationThread(instance, replyId); } catch { msgs = []; }
  for (const m of msgs) {
    entries.push({
      direction: directionOf(m, lead),
      at: m.date_received || m.created_at || "",
      subject: m.subject || "",
      body: htmlToText(m.text_body || m.html_body || ""),
      sender: m.from_name || m.from_email_address || "",
    });
  }

  // Initial campaign cold email — only tracked replies have a lead_id.
  if (leadId) {
    try {
      const first = await getFirstSentEmail(instance, leadId, campaignId ?? null);
      if (first) {
        entries.push({
          direction: "sent",
          at: first.sent_at || "",
          subject: first.email_subject || "",
          body: htmlToText(first.email_body || ""),
          sender: first.sender_email?.email || "",
        });
      }
    } catch { /* ignore — thread still usable without the cold email */ }
  }

  // Oldest-first (the cold email has the earliest sent_at, so it leads).
  entries.sort((a, b) => (a.at || "").localeCompare(b.at || ""));
  return entries;
}

/** Serialize the thread for an AI prompt (keeps the most recent within budget). */
export function threadToPrompt(entries: ThreadEntry[], maxChars = 4000): string {
  const lines = entries
    .filter((e) => e.body)
    .map((e) => `[${e.direction === "sent" ? "US → LEAD" : "LEAD → US"}${e.at ? " " + e.at.slice(0, 10) : ""}]${e.subject ? " (" + e.subject + ")" : ""}\n${e.body}`);
  let out = lines.join("\n\n");
  if (out.length > maxChars) out = out.slice(-maxChars);
  return out;
}
