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

// A single client's approved contact emails, cached 5 min per tag.
const _byTag = new Map<string, { set: Set<string>; ts: number }>();
export async function loadClientContactEmails(clientTag: string | null | undefined): Promise<Set<string>> {
  const tag = (clientTag || "").trim();
  if (!tag) return new Set();
  const now = Date.now();
  const hit = _byTag.get(tag);
  if (hit && now - hit.ts < ALL_TTL_MS) return hit.set;
  const set = new Set<string>();
  try {
    const r = await db.execute({
      sql: `SELECT ${CONTACT_KEYS.join(", ")} FROM client_config WHERE client_tag = ?`,
      args: [tag],
    });
    for (const row of r.rows) {
      for (const e of collectConfigEmails(row as Record<string, unknown>)) set.add(e);
    }
  } catch { /* table missing / error → empty set */ }
  _byTag.set(tag, { set, ts: now });
  return set;
}

// email → client tags that have it configured as a CC/BCC contact. Cached 5 min.
let _emailMap: { map: Map<string, string[]>; ts: number } | null = null;
export async function loadClientContactEmailMap(): Promise<Map<string, string[]>> {
  const now = Date.now();
  if (_emailMap && now - _emailMap.ts < ALL_TTL_MS) return _emailMap.map;
  const map = new Map<string, string[]>();
  try {
    const r = await db.execute(`SELECT client_tag, ${CONTACT_KEYS.join(", ")} FROM client_config`);
    for (const row of r.rows) {
      const tag = String((row as Record<string, unknown>).client_tag ?? "").trim().toUpperCase();
      if (!tag) continue;
      for (const e of collectConfigEmails(row as Record<string, unknown>)) {
        const arr = map.get(e) ?? [];
        if (!arr.includes(tag)) arr.push(tag);
        map.set(e, arr);
      }
    }
  } catch { /* table missing / error → empty map */ }
  _emailMap = { map, ts: now };
  return map;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export interface ClientEmailFlag {
  email: string;
  clientTags: string[];
}

/**
 * Scan free text (e.g. a reply body, including quoted content) for any email
 * that a client has configured as a CC/BCC contact. Returns each matched email
 * with the client tag(s) it belongs to — used to FLAG (not reassign) which
 * client a reply is really for. Emails are extracted (not substring-matched) to
 * avoid partial hits.
 */
export function findClientEmailsInText(
  text: string | null | undefined,
  map: Map<string, string[]>,
): ClientEmailFlag[] {
  if (!text || map.size === 0) return [];
  const out: ClientEmailFlag[] = [];
  const seen = new Set<string>();
  for (const m of String(text).matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase();
    if (seen.has(e)) continue;
    seen.add(e);
    const tags = map.get(e);
    if (tags && tags.length) out.push({ email: e, clientTags: tags });
  }
  return out;
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
