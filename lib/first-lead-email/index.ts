/**
 * "Important: First Set of Leads - Instructions" — emailed from madison@ to a client the moment
 * their very first lead is pushed to their lead tracking sheet (OutboundHero, 2026-10-19).
 *
 * First lead = Reply Router never pushed a lead for this client before (leads pushed in the same
 * 30-minute burst count as one first batch) AND the client's sheet holds no other leads. Every
 * client gets one record (Turso first_lead_email), claimed atomically, so the email can never go
 * twice; clients who already had leads are recorded as "existing" the first time they're seen.
 * Recipients: the client's CC people in Reply Router (To) and its BCC — as every client email.
 * Real sending only when FIRST_LEAD_EMAIL_SEND=1; otherwise it's recorded as "would have sent".
 */
import db from "@/lib/db";
import supabase from "@/lib/supabase";
import { clientContacts } from "@/lib/onboarding/contacts";
import { getSheetForClient } from "@/lib/google-sheets-registry";
import { getAuth as getSheetsAuth } from "@/lib/push-to-sheet";
import { google } from "googleapis";
import { renderFirstLeadEmail, firstNameOf, GIF_CID } from "./template";

export const FROM = { email: "madison@outboundhero.co", name: "Madison Herzog" };
const BURST_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 3;
export const sendingSwitchedOn = () => process.env.FIRST_LEAD_EMAIL_SEND === "1";

export type FirstLeadStatus = "checking" | "existing" | "skipped" | "dry" | "sending" | "sent" | "failed" | "unsure";
export interface FirstLeadRecord {
  client_tag: string;
  status: FirstLeadStatus;
  reason: string | null;
  lead_email: string | null;
  first_name: string | null;
  sheet_url: string | null;
  to: string[];
  bcc: string[];
  message_id: string | null;
  attempts: number;
  detected_at: string;
  sent_at: string | null;
  sent_by: string | null;
  updated_at: string;
}

let ready: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!ready) {
    ready = db.execute(`CREATE TABLE IF NOT EXISTS first_lead_email (
      client_tag TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT, reply_id INTEGER,
      lead_email TEXT, first_name TEXT, sheet_url TEXT, to_json TEXT, bcc_json TEXT,
      message_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, detected_at TEXT NOT NULL,
      sent_at TEXT, sent_by TEXT, updated_at TEXT NOT NULL)`).then(() => undefined).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const now = () => new Date().toISOString();
const parseList = (v: unknown): string[] => { try { const a = JSON.parse(String(v ?? "[]")); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
function toRecord(r: Record<string, unknown>): FirstLeadRecord {
  return {
    client_tag: String(r.client_tag), status: String(r.status) as FirstLeadStatus, reason: (r.reason as string) ?? null,
    lead_email: (r.lead_email as string) ?? null, first_name: (r.first_name as string) ?? null, sheet_url: (r.sheet_url as string) ?? null,
    to: parseList(r.to_json), bcc: parseList(r.bcc_json), message_id: (r.message_id as string) ?? null, attempts: Number(r.attempts ?? 0),
    detected_at: String(r.detected_at), sent_at: (r.sent_at as string) ?? null, sent_by: (r.sent_by as string) ?? null, updated_at: String(r.updated_at),
  };
}

export async function getFirstLeadRecord(tag: string): Promise<FirstLeadRecord | null> {
  await ensureTable();
  const r = await db.execute({ sql: "SELECT * FROM first_lead_email WHERE client_tag = ?", args: [tag.toUpperCase()] });
  return r.rows[0] ? toRecord(r.rows[0] as Record<string, unknown>) : null;
}

async function update(tag: string, patch: Record<string, string | number | null>): Promise<void> {
  const keys = Object.keys(patch);
  await db.execute({
    sql: `UPDATE first_lead_email SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE client_tag = ?`,
    args: [...keys.map((k) => patch[k]), now(), tag],
  });
}

// ── What the email needs ─────────────────────────────────────────────────────

export interface PushedRow { lead_email: string | null; lead_name: string | null; pushed_to_sheet_at: string | null }

/**
 * Is this a client's first lead? (pure — the rules, tested on their own)
 *  · any lead Reply Router pushed before this burst (or with no push time — an old one) → not first
 *  · any lead in the sheet that isn't one of this burst's → not first (the sheet already had leads)
 *  · otherwise the first lead is the earliest of the burst
 * `sheetEmails` is column A of the sheet (header included), or null when there's no sheet to read.
 */
export function decideFirstLead(tag: string, rows: PushedRow[], sheetEmails: string[] | null, detectedAt: string): { first: PushedRow | null; existingReason: string | null } {
  const since = Date.parse(detectedAt) - BURST_MS;
  const sorted = [...rows].sort((a, b) => (a.pushed_to_sheet_at ? Date.parse(a.pushed_to_sheet_at) : -Infinity) - (b.pushed_to_sheet_at ? Date.parse(b.pushed_to_sheet_at) : -Infinity));
  const before = sorted.find((r) => !r.pushed_to_sheet_at || Date.parse(r.pushed_to_sheet_at) < since);
  if (before) return { first: null, existingReason: `Reply Router already pushed leads for ${tag} before (${before.lead_email ?? "a lead"}${before.pushed_to_sheet_at ? ` on ${before.pushed_to_sheet_at.slice(0, 10)}` : ""}).` };
  const burst = sorted.filter((r) => r.lead_email);
  if (sheetEmails) {
    const ours = new Set(burst.map((r) => String(r.lead_email).trim().toLowerCase()));
    const others = sheetEmails.map((e) => String(e ?? "").trim().toLowerCase()).filter((e) => e.includes("@") && !ours.has(e));
    if (others.length) return { first: null, existingReason: `${tag}'s sheet already had ${others.length} lead${others.length === 1 ? "" : "s"} in it (e.g. ${others[0]}).` };
  }
  return { first: burst[0] ?? null, existingReason: null };
}

interface Facts {
  first: { lead_email: string; lead_name: string | null } | null;   // the first lead (null = not a first lead)
  existingReason: string | null;
  sheetUrl: string | null;
  to: string[];
  bcc: string[];
}

/** Reply Router's history + the sheet itself decide whether this client ever had a lead before. */
async function gatherFacts(tag: string, detectedAt: string, opts: { ignoreHistory?: boolean } = {}): Promise<Facts> {
  const facts: Facts = { first: null, existingReason: null, sheetUrl: null, to: [], bcc: [] };
  const { data, error } = await supabase
    .from("replies").select("lead_email, lead_name, pushed_to_sheet_at")
    .eq("client_tag", tag).eq("pushed_to_sheet", true)
    .order("pushed_to_sheet_at", { ascending: true, nullsFirst: true }).limit(100);
  if (error) throw new Error(`Couldn't read the client's lead history: ${error.message}`);
  const rows = (data ?? []) as PushedRow[];
  const sheet = await getSheetForClient(tag);
  if (sheet) facts.sheetUrl = `https://docs.google.com/spreadsheets/d/${sheet.id}/edit`;
  if (opts.ignoreHistory) {
    // "Send now" / tests: the earliest lead pushed for this client, whatever came before.
    const r = rows.find((x) => x.lead_email);
    facts.first = r ? { lead_email: String(r.lead_email), lead_name: r.lead_name } : null;
  } else {
    let sheetEmails: string[] | null = null;
    if (sheet) {
      const res = await google.sheets({ version: "v4", auth: getSheetsAuth() }).spreadsheets.values.get({ spreadsheetId: sheet.id, range: `'${sheet.sheetName}'!A:A` });
      sheetEmails = (res.data.values ?? []).map((r) => String(r[0] ?? ""));
    }
    const d = decideFirstLead(tag, rows, sheetEmails, detectedAt);
    facts.existingReason = d.existingReason;
    facts.first = d.first?.lead_email ? { lead_email: String(d.first.lead_email), lead_name: d.first.lead_name } : null;
  }
  const c = await clientContacts(tag);
  facts.to = c.to; facts.bcc = c.bcc;
  return facts;
}

async function deliver(tag: string, f: Facts, by: string): Promise<FirstLeadRecord> {
  const firstName = firstNameOf(f.first!.lead_name);
  const mail = renderFirstLeadEmail({ firstName, leadEmail: f.first!.lead_email, sheetUrl: f.sheetUrl! });
  await update(tag, { status: "sending", lead_email: f.first!.lead_email, first_name: firstName, sheet_url: f.sheetUrl, to_json: JSON.stringify(f.to), bcc_json: JSON.stringify(f.bcc), reason: null });
  try {
    const { sendEmailAs } = await import("@/lib/gmail-send");
    const { MOVE_TO_CC_GIF_BASE64 } = await import("./gif");
    const sent = await sendEmailAs({
      fromEmail: FROM.email, fromName: FROM.name, to: f.to, bcc: f.bcc, subject: mail.subject, html: mail.html, text: mail.text,
      inline: [{ cid: GIF_CID, filename: "move-to-cc.gif", contentType: "image/gif", base64: MOVE_TO_CC_GIF_BASE64 }],
      allowAnyRecipient: sendingSwitchedOn(),
    });
    await update(tag, { status: "sent", message_id: sent.id, sent_at: now(), sent_by: by });
  } catch (e) {
    const err = e as Error & { uncertain?: boolean };
    const rec = await getFirstLeadRecord(tag);
    // Gmail may have sent it before the connection dropped — never resend that on our own.
    if (err.uncertain) await update(tag, { status: "unsure", reason: `${err.message} — it may have gone out; check Madison's Sent folder before using Send now.`.slice(0, 1000) });
    else await update(tag, { status: "failed", reason: err.message.slice(0, 1000), attempts: (rec?.attempts ?? 0) + 1 });
  }
  return (await getFirstLeadRecord(tag))!;
}

/** Decide and (when switched on) send. Safe to call any number of times — it acts once per client. */
export async function processFirstLead(tagRaw: string, replyId: number | null, by = "auto"): Promise<FirstLeadRecord | null> {
  await ensureTable();
  const tag = tagRaw.trim().toUpperCase();
  const t = now();
  const claim = await db.execute({
    sql: "INSERT OR IGNORE INTO first_lead_email (client_tag, status, reply_id, attempts, detected_at, updated_at) VALUES (?, 'checking', ?, 0, ?, ?)",
    args: [tag, replyId, t, t],
  });
  let rec = await getFirstLeadRecord(tag);
  if (!rec) return null;
  if (claim.rowsAffected === 0) {
    // Someone else has (or had) it. Only pick up a failed send, or a check that died part-way.
    const stale = Date.now() - Date.parse(rec.updated_at) > 10 * 60 * 1000;
    const retry = (rec.status === "failed" && rec.attempts < MAX_ATTEMPTS) || (rec.status === "checking" && stale);
    if (!retry) return rec;
    const again = await db.execute({ sql: "UPDATE first_lead_email SET updated_at = ? WHERE client_tag = ? AND updated_at = ?", args: [now(), tag, rec.updated_at] });
    if (again.rowsAffected === 0) return rec; // another worker just took it
    rec = (await getFirstLeadRecord(tag))!;
  }
  let f: Facts;
  try { f = await gatherFacts(tag, rec.detected_at); }
  catch (e) { await update(tag, { status: "failed", reason: (e as Error).message.slice(0, 1000), attempts: rec.attempts + 1 }); return getFirstLeadRecord(tag); }
  if (f.existingReason) { await update(tag, { status: "existing", reason: f.existingReason }); return getFirstLeadRecord(tag); }
  if (!f.first) { await update(tag, { status: "skipped", reason: "No pushed lead found for this client yet." }); return getFirstLeadRecord(tag); }
  if (!f.sheetUrl) { await update(tag, { status: "skipped", reason: `${tag} has no lead tracking sheet in LeadSync.`, lead_email: f.first.lead_email }); return getFirstLeadRecord(tag); }
  if (!f.to.length) {
    await update(tag, { status: "skipped", reason: `${tag} has no CC contacts in Reply Router — add them on the client page, then use Send now.`, lead_email: f.first.lead_email, sheet_url: f.sheetUrl });
    return getFirstLeadRecord(tag);
  }
  if (!sendingSwitchedOn()) {
    const firstName = firstNameOf(f.first.lead_name);
    await update(tag, { status: "dry", reason: "Sending to clients is switched off (FIRST_LEAD_EMAIL_SEND) — this is who it would have gone to.", lead_email: f.first.lead_email, first_name: firstName, sheet_url: f.sheetUrl, to_json: JSON.stringify(f.to), bcc_json: JSON.stringify(f.bcc) });
    return getFirstLeadRecord(tag);
  }
  return deliver(tag, f, by);
}

/** Called after a NEW row lands in a client's sheet. Cheap when the client already has a record. */
export async function onLeadPushedToSheet(clientTag: string, replyId: number): Promise<void> {
  try {
    await ensureTable();
    const tag = clientTag.trim().toUpperCase();
    const has = await db.execute({ sql: "SELECT status FROM first_lead_email WHERE client_tag = ?", args: [tag] });
    if (has.rows.length) return;
    const run = () => processFirstLead(tag, replyId).catch((e) => console.error("[first-lead-email]", tag, (e as Error).message));
    try {
      const { after } = await import("next/server");
      after(run);
    } catch {
      await run(); // outside a request (scripts) — just run it
    }
  } catch (e) {
    console.error("[first-lead-email] note failed:", (e as Error).message);
  }
}

/** Admin: send it now for real (switch must be on) — e.g. after adding missing contacts. */
export async function sendFirstLeadNow(tagRaw: string, by: string): Promise<FirstLeadRecord> {
  if (!sendingSwitchedOn()) throw new Error("Sending to clients is switched off (FIRST_LEAD_EMAIL_SEND isn't 1).");
  await ensureTable();
  const tag = tagRaw.trim().toUpperCase();
  const rec = await getFirstLeadRecord(tag);
  if (rec?.status === "sent") throw new Error(`Already sent to ${tag} on ${rec.sent_at?.slice(0, 10)}.`);
  if (rec?.status === "sending") throw new Error("It's being sent right now.");
  if (!rec) await db.execute({ sql: "INSERT OR IGNORE INTO first_lead_email (client_tag, status, attempts, detected_at, updated_at) VALUES (?, 'checking', 0, ?, ?)", args: [tag, now(), now()] });
  const f = await gatherFacts(tag, now(), { ignoreHistory: true });
  if (rec?.lead_email) f.first = { lead_email: rec.lead_email, lead_name: f.first?.lead_email === rec.lead_email ? f.first.lead_name : rec.first_name };
  if (!f.first) throw new Error(`${tag} has no lead in its sheet yet.`);
  if (!f.sheetUrl) throw new Error(`${tag} has no lead tracking sheet in LeadSync.`);
  if (!f.to.length) throw new Error(`${tag} has no CC contacts in Reply Router.`);
  const out = await deliver(tag, f, by);
  if (out.status !== "sent") throw new Error(out.reason ?? "It didn't send.");
  return out;
}

/** Admin: the exact email this client gets (or got), sent only to a test address. */
export async function sendFirstLeadTest(tagRaw: string, testTo: string): Promise<{ to: string[]; bcc: string[]; leadEmail: string; firstName: string; sheetUrl: string }> {
  const tag = tagRaw.trim().toUpperCase();
  const f = await gatherFacts(tag, now(), { ignoreHistory: true });
  const rec = await getFirstLeadRecord(tag);
  const leadEmail = rec?.lead_email ?? f.first?.lead_email ?? "first.lead@example.com";
  const firstName = rec?.first_name ?? firstNameOf(f.first?.lead_name ?? "Stephanie");
  const sheetUrl = f.sheetUrl ?? "https://docs.google.com/spreadsheets/d/(no-sheet-yet)/edit";
  const banner = `TEST for ${tag} — the real email goes to ${f.to.length ? f.to.join(", ") : "(no CC contacts yet)"}${f.bcc.length ? `, BCC ${f.bcc.join(", ")}` : ""}.`;
  const mail = renderFirstLeadEmail({ firstName, leadEmail, sheetUrl }, { testBanner: banner });
  const { sendEmailAs } = await import("@/lib/gmail-send");
  const { MOVE_TO_CC_GIF_BASE64 } = await import("./gif");
  await sendEmailAs({
    fromEmail: FROM.email, fromName: FROM.name, to: [testTo], subject: mail.subject, html: mail.html, text: mail.text,
    inline: [{ cid: GIF_CID, filename: "move-to-cc.gif", contentType: "image/gif", base64: MOVE_TO_CC_GIF_BASE64 }],
    allowAnyRecipient: false, // tests only ever go to the test addresses
  });
  return { to: f.to, bcc: f.bcc, leadEmail, firstName, sheetUrl };
}

/** Cron: retry failed sends (up to 3 tries) and checks that died part-way. */
export async function retryFirstLeadEmails(): Promise<Array<{ tag: string; status: string }>> {
  await ensureTable();
  const due = await db.execute({
    sql: `SELECT client_tag FROM first_lead_email
          WHERE (status = 'failed' AND attempts < ?) OR (status = 'checking' AND updated_at < ?)`,
    args: [MAX_ATTEMPTS, new Date(Date.now() - 10 * 60 * 1000).toISOString()],
  });
  const out: Array<{ tag: string; status: string }> = [];
  for (const r of due.rows) {
    const rec = await processFirstLead(String(r.client_tag), null, "retry");
    out.push({ tag: String(r.client_tag), status: rec?.status ?? "?" });
  }
  return out;
}
