/**
 * Known-client detection (ReplyRouter spec §5).
 *
 * If any address on a reply's From / To / CC / BCC is one of our approved client
 * contacts, the client's own team is on the thread → hard-mark the lead
 * "Meeting-Ready Lead", overriding the AI category. Scope (per the product
 * decision):
 *   - reply has a resolved client tag  → match against THAT client's contacts
 *   - reply has no tag / lead id        → match against ALL clients' contacts
 *
 * Approved contacts are the client_config CC/BCC emails (cc_email_1..6,
 * bcc_email_1..2). Case-insensitive, whitespace-trimmed.
 */
import db from "@/lib/db";

const CONTACT_KEYS = [
  "cc_email_1", "cc_email_2", "cc_email_3", "cc_email_4", "cc_email_5", "cc_email_6",
  "bcc_email_1", "bcc_email_2",
] as const;

/** Lowercased contact emails from a single client_config row. */
export function collectConfigEmails(config: Record<string, unknown> | null | undefined): string[] {
  if (!config) return [];
  const out: string[] = [];
  for (const k of CONTACT_KEYS) {
    const v = config[k as string];
    if (v != null) {
      const e = String(v).trim().toLowerCase();
      if (e) out.push(e);
    }
  }
  return out;
}

// Every client's approved contacts, cached 5 min (they change rarely).
let _allContacts: { set: Set<string>; ts: number } | null = null;
const ALL_TTL_MS = 5 * 60 * 1000;
export async function loadAllClientContactEmails(): Promise<Set<string>> {
  const now = Date.now();
  if (_allContacts && now - _allContacts.ts < ALL_TTL_MS) return _allContacts.set;
  const set = new Set<string>();
  try {
    const r = await db.execute(`SELECT ${CONTACT_KEYS.join(", ")} FROM client_config`);
    for (const row of r.rows) {
      for (const k of CONTACT_KEYS) {
        const v = (row as Record<string, unknown>)[k];
        if (v != null) {
          const e = String(v).trim().toLowerCase();
          if (e) set.add(e);
        }
      }
    }
  } catch { /* table missing / error → empty set */ }
  _allContacts = { set, ts: now };
  return set;
}

interface ReplyLike {
  from_email_address?: string | null;
  to?: Array<{ name?: string; address?: string }> | null;
  cc?: Array<{ name?: string; address?: string }> | null;
  bcc?: Array<{ name?: string; address?: string }> | null;
}

/** All participant addresses on the reply (From + To + CC + BCC), lowercased. */
export function replyParticipantEmails(reply: ReplyLike): string[] {
  const out: string[] = [];
  if (reply.from_email_address) out.push(String(reply.from_email_address));
  for (const arr of [reply.to, reply.cc, reply.bcc]) {
    if (Array.isArray(arr)) for (const p of arr) if (p?.address) out.push(String(p.address));
  }
  return out.map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/**
 * True if any From/To/CC/BCC address on the reply is a known client contact —
 * that client's (when `config` is provided) else any client's.
 */
export async function isKnownClientReply(
  config: Record<string, unknown> | null | undefined,
  reply: ReplyLike,
): Promise<boolean> {
  const emails = replyParticipantEmails(reply);
  if (!emails.length) return false;
  const contacts = config ? new Set(collectConfigEmails(config)) : await loadAllClientContactEmails();
  if (!contacts.size) return false;
  return emails.some((e) => contacts.has(e));
}

/** @deprecated From-only, own-client check — superseded by isKnownClientReply. */
export function isCcBccSender(
  config: Record<string, unknown> | null | undefined,
  fromEmail: string | null | undefined,
): boolean {
  if (!config || !fromEmail) return false;
  const target = String(fromEmail).trim().toLowerCase();
  if (!target) return false;
  return collectConfigEmails(config).includes(target);
}
