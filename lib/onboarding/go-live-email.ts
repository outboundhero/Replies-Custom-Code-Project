/**
 * The client go-live email (onboarding checklist, "Send client go-live email").
 *
 * Who it's from depends on the day it's sent (OutboundHero, 2026-10-23): nick@outboundhero.co until
 * Oct 31, madison@outboundhero.co from Nov 1 on. It goes out from that mailbox through Gmail
 * (lib/gmail-send.ts), signed by the sender, to the client's contacts — the same people as every client
 * email: Reply Router's CC people (To) and BCC — with Spencer and Madison in CC.
 *
 * One email per client, ever: a record (Turso go_live_email) is claimed before sending. Real sending
 * only when GO_LIVE_EMAIL_SEND=1; until then the step is a preview.
 */
import db from "@/lib/db";

export const goLiveSendEnabled = () => process.env.GO_LIVE_EMAIL_SEND === "1";

export interface Sender { email: string; name: string }
const NICK: Sender = { email: "nick@outboundhero.co", name: "Nick Mekeel" };
const MADISON: Sender = { email: "madison@outboundhero.co", name: "Madison Herzog" };
/** The first day (Pacific time) it goes out from Madison (GO_LIVE_MADISON_FROM, YYYY-MM-DD, can move it). */
export const madisonFrom = () => (/^\d{4}-\d{2}-\d{2}$/.test(process.env.GO_LIVE_MADISON_FROM ?? "") ? process.env.GO_LIVE_MADISON_FROM! : "2026-11-01");

const pacificDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
/** Who sends it on this day. */
export function goLiveSender(at = new Date()): Sender {
  return pacificDay(at) >= madisonFrom() ? MADISON : NICK;
}

export const GO_LIVE_SUBJECT = "OutboundHero Update";
/** The email (fixed by the requirements of 2026-09-21), signed by whoever sends it. */
export function goLiveText(sender: Sender): string {
  return [
    "Hi Team,",
    "",
    "Just wanted to let you know we are going live with your campaigns tomorrow morning. You should start to see your first leads come your way in the next couple of days. Spencer will follow up with lead instructions. Let me know if you have any questions.",
    "",
    "Cheers,",
    sender.name,
    "OutboundHero",
  ].join("\n");
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function goLiveHtml(sender: Sender): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${goLiveText(sender).split("\n").map((l) => (l ? esc(l) : "")).join("<br>")}</div>`;
}

/** CC: Spencer + Madison (ONBOARDING_GO_LIVE_CC overrides), never the sender or anyone already in To. */
export function goLiveCc(sender: Sender, to: string[]): string[] {
  const base = (process.env.ONBOARDING_GO_LIVE_CC || "spencer@outboundhero.co,madison@outboundhero.co").split(",").map((e) => e.trim()).filter(Boolean);
  const taken = new Set([sender.email, ...to].map((e) => e.toLowerCase()));
  return base.filter((e) => !taken.has(e.toLowerCase()));
}

// ── one per client ──────────────────────────────────────────────────────────

export type GoLiveStatus = "sending" | "sent" | "failed" | "unsure";
export interface GoLiveRecord {
  client_tag: string; status: GoLiveStatus; from_email: string; to: string[]; cc: string[]; bcc: string[];
  message_id: string | null; reason: string | null; sent_at: string | null; sent_by: string | null; updated_at: string;
}

let ready: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!ready) {
    ready = db.execute(`CREATE TABLE IF NOT EXISTS go_live_email (
      client_tag TEXT PRIMARY KEY, status TEXT NOT NULL, from_email TEXT NOT NULL, to_json TEXT, cc_json TEXT, bcc_json TEXT,
      message_id TEXT, reason TEXT, sent_at TEXT, sent_by TEXT, updated_at TEXT NOT NULL)`).then(() => undefined).catch((e) => { ready = null; throw e; });
  }
  return ready;
}
const list = (v: unknown): string[] => { try { const a = JSON.parse(String(v ?? "[]")); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };

export async function getGoLiveRecord(tag: string): Promise<GoLiveRecord | null> {
  await ensureTable();
  const r = await db.execute({ sql: "SELECT * FROM go_live_email WHERE client_tag = ?", args: [tag.toUpperCase()] });
  const x = r.rows[0];
  return x ? {
    client_tag: String(x.client_tag), status: String(x.status) as GoLiveStatus, from_email: String(x.from_email),
    to: list(x.to_json), cc: list(x.cc_json), bcc: list(x.bcc_json), message_id: (x.message_id as string) ?? null,
    reason: (x.reason as string) ?? null, sent_at: (x.sent_at as string) ?? null, sent_by: (x.sent_by as string) ?? null, updated_at: String(x.updated_at),
  } : null;
}

/**
 * Take the one send for this client: only when there's no record yet, or the last try plainly failed
 * (nothing went out). False when it was sent, may have been sent ("unsure"), or is being sent right now.
 */
export async function claimGoLive(tag: string, m: { from: string; to: string[]; cc: string[]; bcc: string[]; by: string | null }): Promise<boolean> {
  await ensureTable();
  const now = new Date().toISOString();
  const r = await db.execute({
    sql: `INSERT INTO go_live_email (client_tag, status, from_email, to_json, cc_json, bcc_json, sent_by, updated_at)
          VALUES (?, 'sending', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(client_tag) DO UPDATE SET status = 'sending', from_email = excluded.from_email, to_json = excluded.to_json,
            cc_json = excluded.cc_json, bcc_json = excluded.bcc_json, sent_by = excluded.sent_by, reason = NULL, updated_at = excluded.updated_at
          WHERE go_live_email.status = 'failed'`,
    args: [tag.toUpperCase(), m.from, JSON.stringify(m.to), JSON.stringify(m.cc), JSON.stringify(m.bcc), m.by, now],
  });
  return (r.rowsAffected ?? 0) > 0;
}

export async function finishGoLive(tag: string, status: Exclude<GoLiveStatus, "sending">, f: { message_id?: string | null; reason?: string | null }): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    sql: "UPDATE go_live_email SET status = ?, message_id = ?, reason = ?, sent_at = ?, updated_at = ? WHERE client_tag = ? AND status = 'sending'",
    args: [status, f.message_id ?? null, f.reason ?? null, status === "sent" ? now : null, now, tag.toUpperCase()],
  });
}
