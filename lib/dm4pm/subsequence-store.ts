/**
 * DM4PM subsequence — persistent state store (Turso/libsql).
 *
 * Owns three tables and every state transition for the 7-step engine. Mirrors
 * the `lib/send-retry.ts` idiom (lazy CREATE TABLE, `db.execute({sql,args})`,
 * status/attempt columns, one-row-per-subject dedupe).
 *
 * State lives in Turso; the enrolled reply lives in Supabase. On every
 * transition we best-effort mirror `dm4pm_subseq_status`/`dm4pm_subseq_step`
 * onto the `replies` row so the inbox badge + "DM4PM Subsequence" view can
 * filter/count server-side (see module K).
 */
import db from "@/lib/db";
import supabase from "@/lib/supabase";
import { scheduleFrom, STEP_CADENCE } from "@/lib/business-days";

export type SubStatus = "active" | "paused" | "snoozed" | "stopped" | "completed";
export type PausedReason =
  | "prospect_reply" | "meeting_booked" | "canceled_meeting" | "manual" | "awaiting_inbox" | "sender_failed";
export type MeetingState = "none" | "booked" | "attended" | "no_show" | "canceled";

const nowIso = () => new Date().toISOString();

let ready = false;
async function ensureTables(): Promise<void> {
  if (ready) return;
  await db.execute(`CREATE TABLE IF NOT EXISTS dm4pm_subsequence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reply_row_id INTEGER NOT NULL UNIQUE,
    client_tag TEXT,
    bison_instance TEXT NOT NULL,
    reply_id INTEGER,
    active_reply_id INTEGER,
    lead_id INTEGER,
    lead_email TEXT,
    campaign_id INTEGER,
    sender_email_id INTEGER,
    sender_email TEXT,
    sender_name TEXT,
    to_name TEXT,
    subject TEXT,
    first_name TEXT,
    first_name_confirmed INTEGER NOT NULL DEFAULT 0,
    phone TEXT,
    phone_confirmed INTEGER NOT NULL DEFAULT 0,
    do_not_call INTEGER NOT NULL DEFAULT 0,
    step INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    paused_reason TEXT,
    next_step_due_at TEXT,
    snooze_until TEXT,
    last_our_response_at TEXT,
    continuation_due_at TEXT,
    meeting_state TEXT NOT NULL DEFAULT 'none',
    enrolled_at TEXT,
    updated_at TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS dm4pm_subsequence_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subsequence_id INTEGER NOT NULL,
    step INTEGER NOT NULL,
    sent_at TEXT,
    sender_email_id INTEGER,
    bison_reply_id INTEGER,
    status TEXT NOT NULL,
    error TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS recontact_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reply_row_id INTEGER NOT NULL UNIQUE,
    client_tag TEXT,
    lead_email TEXT,
    reason TEXT,
    added_at TEXT,
    handled_at TEXT
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_dm4pm_sub_status_due ON dm4pm_subsequence(status, next_step_due_at)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_dm4pm_sub_email ON dm4pm_subsequence(lead_email)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_dm4pm_sends_sub_step ON dm4pm_subsequence_sends(subsequence_id, step)`);
  ready = true;
}

export interface SubsequenceRow {
  id: number;
  reply_row_id: number;
  client_tag: string | null;
  bison_instance: string;
  reply_id: number | null;
  active_reply_id: number | null;
  lead_id: number | null;
  lead_email: string | null;
  campaign_id: number | null;
  sender_email_id: number | null;
  sender_email: string | null;
  sender_name: string | null;
  to_name: string | null;
  subject: string | null;
  first_name: string | null;
  first_name_confirmed: number;
  phone: string | null;
  phone_confirmed: number;
  do_not_call: number;
  step: number;
  status: SubStatus;
  paused_reason: string | null;
  next_step_due_at: string | null;
  snooze_until: string | null;
  last_our_response_at: string | null;
  continuation_due_at: string | null;
  meeting_state: MeetingState;
  enrolled_at: string | null;
  updated_at: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRow(r: any): SubsequenceRow {
  return r as SubsequenceRow;
}

/** Best-effort mirror of status/step onto the Supabase replies row (module K). */
async function mirrorToReply(replyRowId: number, status: SubStatus | null, step: number): Promise<void> {
  try {
    await supabase
      .from("replies")
      .update({ dm4pm_subseq_status: status, dm4pm_subseq_step: status ? step : null })
      .eq("id", replyRowId);
  } catch { /* columns may not exist yet / transient — never block a transition */ }
}

export interface EnrollParams {
  replyRowId: number;
  clientTag: string | null;
  bisonInstance: string;
  replyId: number | null;
  leadId: number | null;
  leadEmail: string | null;
  campaignId: number | null;
  senderEmailId: number | null;
  senderEmail: string | null;
  senderName: string | null;
  toName: string | null;
  subject: string | null;
  firstName: string;
  firstNameConfirmed: boolean;
  phone: string;
  phoneConfirmed: boolean;
  doNotCall: boolean;
}

/**
 * Enroll a reply (§4/§24). Idempotent on `reply_row_id` — a second enroll is a
 * no-op and returns the existing row. Schedules Step 1 at +25h → next business
 * day 09:00 PT. Returns the row (existing or new).
 */
export async function enroll(p: EnrollParams): Promise<SubsequenceRow> {
  await ensureTables();
  // Dedup (§24): an enrollment already on this reply row, or any LIVE
  // enrollment for this prospect's email (repeat replies spawn new reply rows,
  // so the email is the stable identity).
  const existing = await getByReplyRowId(p.replyRowId);
  if (existing) return existing;
  if (p.leadEmail) {
    const byEmail = await getByEmail(p.leadEmail);
    if (byEmail && LIVE_STATUSES.includes(byEmail.status)) return byEmail;
  }

  const now = nowIso();
  const due = scheduleFrom(new Date(), STEP_CADENCE[0]).toISOString();
  await db.execute({
    sql: `INSERT INTO dm4pm_subsequence
      (reply_row_id, client_tag, bison_instance, reply_id, active_reply_id, lead_id, lead_email,
       campaign_id, sender_email_id, sender_email, sender_name, to_name, subject,
       first_name, first_name_confirmed, phone, phone_confirmed, do_not_call,
       step, status, next_step_due_at, meeting_state, enrolled_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'active',?,'none',?,?)`,
    args: [
      p.replyRowId, p.clientTag, p.bisonInstance, p.replyId, p.replyId, p.leadId, p.leadEmail,
      p.campaignId, p.senderEmailId, p.senderEmail, p.senderName, p.toName, p.subject,
      p.firstName || null, p.firstNameConfirmed ? 1 : 0, p.phone || null, p.phoneConfirmed ? 1 : 0, p.doNotCall ? 1 : 0,
      due, now, now,
    ],
  });
  await mirrorToReply(p.replyRowId, "active", 0);
  const row = await getByReplyRowId(p.replyRowId);
  if (!row) throw new Error("enroll: row not found after insert");
  return row;
}

export async function getById(id: number): Promise<SubsequenceRow | null> {
  await ensureTables();
  const r = await db.execute({ sql: "SELECT * FROM dm4pm_subsequence WHERE id = ?", args: [id] });
  return r.rows.length ? toRow(r.rows[0]) : null;
}

export async function getByReplyRowId(replyRowId: number): Promise<SubsequenceRow | null> {
  await ensureTables();
  const r = await db.execute({ sql: "SELECT * FROM dm4pm_subsequence WHERE reply_row_id = ?", args: [replyRowId] });
  return r.rows.length ? toRow(r.rows[0]) : null;
}

/** Most-recent enrollment for an email (case-insensitive) — used by the ingest
 *  pause hook, which keys on the stable email rather than a per-thread reply id. */
export async function getByEmail(email: string): Promise<SubsequenceRow | null> {
  await ensureTables();
  const r = await db.execute({
    sql: "SELECT * FROM dm4pm_subsequence WHERE lower(lead_email) = lower(?) ORDER BY id DESC LIMIT 1",
    args: [email],
  });
  return r.rows.length ? toRow(r.rows[0]) : null;
}

const LIVE_STATUSES: SubStatus[] = ["active", "paused", "snoozed"];

/** Is this reply currently in a non-terminal (live) enrollment? (§24 dedupe) */
export async function isEnrolled(replyRowId: number): Promise<boolean> {
  const row = await getByReplyRowId(replyRowId);
  return !!row && LIVE_STATUSES.includes(row.status);
}

type Scalar = string | number | null;

async function patch(id: number, set: Record<string, Scalar>): Promise<void> {
  await ensureTables();
  const cols = Object.keys(set);
  if (!cols.length) return;
  const assignments = cols.map((c) => `${c} = ?`).join(", ");
  await db.execute({
    sql: `UPDATE dm4pm_subsequence SET ${assignments}, updated_at = ? WHERE id = ?`,
    args: [...cols.map((c) => set[c]), nowIso(), id],
  });
}

export async function pause(id: number, reason: PausedReason): Promise<void> {
  await patch(id, { status: "paused", paused_reason: reason });
  const row = await getById(id);
  if (row) await mirrorToReply(row.reply_row_id, "paused", row.step);
}

/** Pause because the prospect replied (§11): preserve step, reset the
 *  continuation timer (a fresh reply restarts the wait for our response). */
export async function pauseForProspectReply(id: number): Promise<void> {
  await patch(id, { status: "paused", paused_reason: "prospect_reply", continuation_due_at: null });
  const row = await getById(id);
  if (row) await mirrorToReply(row.reply_row_id, "paused", row.step);
}

/** Stamp the subsequence badge (status/step) onto a specific reply row — used
 *  when a repeat prospect reply lands on a NEW reply row that should also show
 *  the "In Subsequence" pill / appear in the DM4PM Subsequence view. */
export async function setReplyBadge(replyRowId: number, status: SubStatus | null, step: number): Promise<void> {
  await mirrorToReply(replyRowId, status, step);
}

/**
 * Resume from the next unsent step (§19). Schedules the next step for the next
 * business day at 09:00 PT (fires on the following cron tick if already past).
 * Clears pause/continuation state.
 */
export async function resume(id: number): Promise<void> {
  const due = scheduleFrom(new Date(), { days: 0 }).toISOString();
  await patch(id, { status: "active", paused_reason: null, continuation_due_at: null, next_step_due_at: due });
  const row = await getById(id);
  if (row) await mirrorToReply(row.reply_row_id, "active", row.step);
}

export async function stop(id: number): Promise<void> {
  await patch(id, { status: "stopped", next_step_due_at: null, continuation_due_at: null });
  const row = await getById(id);
  if (row) await mirrorToReply(row.reply_row_id, "stopped", row.step);
}

/**
 * Resume from the next unsent step, waiting `businessDays` business days before
 * it fires (0 = next business day, like resume()). Used by the inbox
 * "Continue subsequence" decision when a paused-by-reply lead is re-categorized.
 */
export async function resumeWithDelay(id: number, businessDays: number): Promise<void> {
  const days = Math.max(0, Math.floor(Number(businessDays) || 0));
  const due = scheduleFrom(new Date(), { businessDays: days }).toISOString();
  await patch(id, { status: "active", paused_reason: null, continuation_due_at: null, next_step_due_at: due });
  const row = await getById(id);
  if (row) await mirrorToReply(row.reply_row_id, "active", row.step);
}

/**
 * Inbox re-categorize gate: return the lead's live enrollment IF it is paused
 * because the prospect replied (moved back to Open Response) — meaning it must be
 * explicitly ended or continued before the lead is re-categorized to a positive
 * bucket. Resolves by the stable email first (a repeat reply the operator is
 * viewing can be a different row than the enrollment), then the reply row.
 * Returns null when there is nothing to resolve.
 */
export async function getReplyPauseGate(replyRowId: number, leadEmail: string | null): Promise<SubsequenceRow | null> {
  const row = (leadEmail ? await getByEmail(leadEmail) : null) || (await getByReplyRowId(replyRowId));
  if (row && row.status === "paused" && row.paused_reason === "prospect_reply") return row;
  return null;
}

export async function markCompleted(id: number): Promise<void> {
  await patch(id, { status: "completed", next_step_due_at: null, continuation_due_at: null });
  const row = await getById(id);
  if (row) await mirrorToReply(row.reply_row_id, "completed", row.step);
}

/** Snooze until `untilIso` (§14). Overrides the 5-day continuation. */
export async function snooze(id: number, untilIso: string): Promise<void> {
  await patch(id, { status: "snoozed", snooze_until: untilIso, continuation_due_at: null, next_step_due_at: null });
  const row = await getById(id);
  if (row) await mirrorToReply(row.reply_row_id, "snoozed", row.step);
}

/** Do-Not-Call (§15): strip phone from future copy, never ask again. */
export async function setDoNotCall(id: number, on = true): Promise<void> {
  await patch(id, { do_not_call: on ? 1 : 0 });
}

/** Update confirmable vars (§25). Only affects FUTURE unsent steps — sent copy
 *  is already sent; renders read these columns at send time. */
export async function updateVars(
  id: number,
  vars: { firstName?: string; firstNameConfirmed?: boolean; phone?: string; phoneConfirmed?: boolean },
): Promise<void> {
  const set: Record<string, Scalar> = {};
  if (vars.firstName !== undefined) set.first_name = vars.firstName || null;
  if (vars.firstNameConfirmed !== undefined) set.first_name_confirmed = vars.firstNameConfirmed ? 1 : 0;
  if (vars.phone !== undefined) set.phone = vars.phone || null;
  if (vars.phoneConfirmed !== undefined) set.phone_confirmed = vars.phoneConfirmed ? 1 : 0;
  await patch(id, set);
}

/** Advance to a sent step and schedule the next one (or clear when finished).
 *  Also clears any continuation timer — a fresh step supersedes it. */
export async function advanceStep(id: number, newStep: number, nextDueAt: string | null): Promise<void> {
  await patch(id, { step: newStep, next_step_due_at: nextDueAt, continuation_due_at: null });
  const row = await getById(id);
  if (row) await mirrorToReply(row.reply_row_id, row.status, newStep);
}

/** Activate a paused row for immediate continuation (§12), firing its next
 *  unsent step now (leaves next_step_due_at for advanceStep to reset). */
export async function activateForContinuation(id: number): Promise<void> {
  await patch(id, { status: "active", paused_reason: null, continuation_due_at: null });
  const row = await getById(id);
  if (row) await mirrorToReply(row.reply_row_id, "active", row.step);
}

export async function setMeetingState(id: number, state: MeetingState): Promise<void> {
  await patch(id, { meeting_state: state });
}

/** Point the subsequence at a new thread (failover new-thread, §20). */
export async function setActiveThread(id: number, bisonReplyId: number): Promise<void> {
  await patch(id, { active_reply_id: bisonReplyId });
}

/** Reassign the sending account (failover, §20). */
export async function reassignSender(
  id: number,
  s: { senderEmailId: number; senderEmail: string; senderName: string },
): Promise<void> {
  await patch(id, { sender_email_id: s.senderEmailId, sender_email: s.senderEmail, sender_name: s.senderName });
}

/** Start the 5-business-day inbox-response continuation timer (§12). */
export async function setContinuation(id: number, dueAtIso: string): Promise<void> {
  await patch(id, { last_our_response_at: nowIso(), continuation_due_at: dueAtIso });
}

// ── Send audit (§26 no-duplicate-send) ───────────────────────────────────────

export async function recordSend(
  subsequenceId: number,
  step: number,
  s: { senderEmailId: number | null; bisonReplyId: number | null; status: "sent" | "failed"; error?: string | null },
): Promise<void> {
  await ensureTables();
  await db.execute({
    sql: `INSERT INTO dm4pm_subsequence_sends (subsequence_id, step, sent_at, sender_email_id, bison_reply_id, status, error)
          VALUES (?,?,?,?,?,?,?)`,
    args: [subsequenceId, step, nowIso(), s.senderEmailId, s.bisonReplyId, s.status, s.error ?? null],
  });
}

/** Has this exact step already been sent successfully? (duplicate-send guard) */
export async function hasSentStep(subsequenceId: number, step: number): Promise<boolean> {
  await ensureTables();
  const r = await db.execute({
    sql: "SELECT 1 FROM dm4pm_subsequence_sends WHERE subsequence_id = ? AND step = ? AND status = 'sent' LIMIT 1",
    args: [subsequenceId, step],
  });
  return r.rows.length > 0;
}

// ── Re-Contact Queue (§17) ───────────────────────────────────────────────────

export async function addToRecontactQueue(p: {
  replyRowId: number; clientTag: string | null; leadEmail: string | null; reason: string;
}): Promise<void> {
  await ensureTables();
  await db.execute({
    sql: `INSERT OR IGNORE INTO recontact_queue (reply_row_id, client_tag, lead_email, reason, added_at)
          VALUES (?,?,?,?,?)`,
    args: [p.replyRowId, p.clientTag, p.leadEmail, p.reason, nowIso()],
  });
}

// ── Cron drains ──────────────────────────────────────────────────────────────

/** Active rows whose next step is due (the step-sender cron). */
export async function getDueActive(limit = 100): Promise<SubsequenceRow[]> {
  await ensureTables();
  const r = await db.execute({
    sql: `SELECT * FROM dm4pm_subsequence
          WHERE status = 'active' AND next_step_due_at IS NOT NULL AND next_step_due_at <= ?
          ORDER BY next_step_due_at ASC LIMIT ?`,
    args: [nowIso(), limit],
  });
  return r.rows.map(toRow);
}

/** Paused rows whose continuation timer has elapsed (§12 → fire next step now). */
export async function getDueContinuation(limit = 100): Promise<SubsequenceRow[]> {
  await ensureTables();
  const r = await db.execute({
    sql: `SELECT * FROM dm4pm_subsequence
          WHERE status = 'paused' AND continuation_due_at IS NOT NULL AND continuation_due_at <= ?
          ORDER BY continuation_due_at ASC LIMIT ?`,
    args: [nowIso(), limit],
  });
  return r.rows.map(toRow);
}

/** Flip snoozed rows whose snooze has elapsed back to active + schedule a step. */
export async function wakeDueSnoozed(): Promise<number> {
  await ensureTables();
  const r = await db.execute({
    sql: `SELECT id FROM dm4pm_subsequence WHERE status = 'snoozed' AND snooze_until IS NOT NULL AND snooze_until <= ?`,
    args: [nowIso()],
  });
  for (const row of r.rows) await resume(Number((row as Record<string, unknown>).id));
  return r.rows.length;
}

/** All non-terminal enrollments (meeting reconcile cron scans these). */
export async function getLiveEnrollments(limit = 1000): Promise<SubsequenceRow[]> {
  await ensureTables();
  const r = await db.execute({
    sql: `SELECT * FROM dm4pm_subsequence WHERE status IN ('active','paused','snoozed') ORDER BY id ASC LIMIT ?`,
    args: [limit],
  });
  return r.rows.map(toRow);
}
