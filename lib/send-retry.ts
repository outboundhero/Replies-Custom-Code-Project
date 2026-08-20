/**
 * Auto-retry queue for reply sends that failed because the sending inbox lost
 * its SMTP auth ("Please re-connect this email account"). Serverless can't sleep
 * an hour, so we persist the pending send and a cron (retry-send-replies) drains
 * it: reconnect the inbox, then re-attempt the SAME reply at +1h, then +2h. If
 * it still fails after that (or fails with a different error), we give up and
 * leave the error for manual handling.
 *
 * Double-send guard: before each retry we check the reply's send_error — if it
 * was cleared (any successful send happened since we enqueued, e.g. a manual
 * retry), we stop.
 */
import db from "@/lib/db";
import supabase from "@/lib/supabase";
import { sendReply, findSenderEmailByAddress } from "@/lib/outboundhero-api";
import { reconnectInbox, isReconnectableSendError } from "@/lib/inboxing-upload";
import { logError, logActivity } from "@/lib/errors";

// Retry the send this many hours after each failure: 1h, then 2h. Empty after
// that = give up. Edit here to change the schedule.
const BACKOFF_HOURS = [1, 2];

let ready = false;
async function ensureTable(): Promise<void> {
  if (ready) return;
  await db.execute(`CREATE TABLE IF NOT EXISTS send_reply_retries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reply_row_id INTEGER NOT NULL,
    bison_instance TEXT NOT NULL,
    reply_id INTEGER,
    sender_email_id INTEGER,
    sender_email TEXT,
    message TEXT,
    to_email TEXT,
    to_name TEXT,
    cc_json TEXT,
    bcc_json TEXT,
    subject TEXT,
    lead_id INTEGER,
    client_tag TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT,
    updated_at TEXT
  )`);
  ready = true;
}

const hoursFromNow = (h: number): string => new Date(Date.now() + h * 3600 * 1000).toISOString();

export interface EnqueueSendRetryParams {
  replyRowId: number;
  bisonInstance: string;
  replyId: number | null;
  senderEmailId: number | null;
  senderEmail: string | null;
  message: string;
  toEmail: string;
  toName: string;
  ccEmails: unknown;
  bccEmails: unknown;
  subject: string | null;
  leadId: number | null;
  clientTag: string | null;
  lastError: string;
}

/** Queue a failed reply for auto-retry (first attempt in BACKOFF_HOURS[0] hours). */
export async function enqueueSendRetry(p: EnqueueSendRetryParams): Promise<void> {
  await ensureTable();
  // One pending retry per reply row — don't stack duplicates on repeated clicks.
  const existing = await db.execute({
    sql: "SELECT id FROM send_reply_retries WHERE reply_row_id = ? AND status = 'pending'",
    args: [p.replyRowId],
  });
  if (existing.rows.length) return;
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO send_reply_retries
            (reply_row_id, bison_instance, reply_id, sender_email_id, sender_email, message,
             to_email, to_name, cc_json, bcc_json, subject, lead_id, client_tag,
             attempt, next_attempt_at, last_error, status, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,'pending',?,?)`,
    args: [
      p.replyRowId, p.bisonInstance, p.replyId, p.senderEmailId, p.senderEmail, p.message,
      p.toEmail, p.toName, JSON.stringify(p.ccEmails ?? null), JSON.stringify(p.bccEmails ?? null),
      p.subject, p.leadId, p.clientTag, hoursFromNow(BACKOFF_HOURS[0]), p.lastError, now, now,
    ],
  });
}

interface RetryRow {
  id: number; reply_row_id: number; bison_instance: string; reply_id: number | null;
  sender_email_id: number | null; sender_email: string | null; message: string;
  to_email: string; to_name: string; cc_json: string | null; bcc_json: string | null;
  subject: string | null; lead_id: number | null; client_tag: string | null; attempt: number;
}

async function setStatus(id: number, status: string, note: string): Promise<void> {
  await db.execute({
    sql: "UPDATE send_reply_retries SET status = ?, last_error = ?, updated_at = ? WHERE id = ?",
    args: [status, note, new Date().toISOString(), id],
  });
}

/** Cron worker: process all due retries. */
export async function processSendRetries(): Promise<{ processed: number; sent: number; rescheduled: number; exhausted: number; skipped: number }> {
  await ensureTable();
  const due = await db.execute({
    sql: "SELECT * FROM send_reply_retries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT 50",
    args: [new Date().toISOString()],
  });
  let sent = 0, rescheduled = 0, exhausted = 0, skipped = 0;

  for (const raw of due.rows) {
    const r = raw as unknown as RetryRow;

    // Double-send guard: send_error cleared → a successful send already happened.
    const { data: reply } = await supabase.from("replies").select("send_error").eq("id", r.reply_row_id).single();
    if (reply && !reply.send_error) {
      await setStatus(r.id, "done", "already sent (error cleared)");
      skipped++;
      continue;
    }

    const ccEmails = r.cc_json ? JSON.parse(r.cc_json) ?? undefined : undefined;
    const bccEmails = r.bcc_json ? JSON.parse(r.bcc_json) ?? undefined : undefined;

    // Re-resolve the sender id by email. A reconnect (or manual re-add) gives the
    // inbox a NEW id, so the stored one can be dead ("sender email id is
    // invalid"). Using the live id makes the retry self-healing; fall back to the
    // stored id if the lookup fails or the inbox isn't back in the instance yet.
    let senderEmailId = r.sender_email_id as number;
    if (r.sender_email) {
      try {
        const live = await findSenderEmailByAddress(String(r.bison_instance), String(r.sender_email));
        if (live) senderEmailId = live.id;
      } catch { /* keep the stored id */ }
    }

    const result = await sendReply(r.bison_instance, {
      replyId: r.reply_id as number,
      senderEmailId,
      message: r.message,
      toEmail: r.to_email,
      toName: r.to_name,
      ccEmails,
      bccEmails,
      subject: r.subject ?? undefined,
      leadId: r.lead_id ?? undefined,
    });

    if (result.ok) {
      const ts = new Date().toISOString();
      await supabase.from("replies")
        .update({ sent_reply: r.message, last_sent_at: ts, send_error: null, send_error_at: null, updated_at: ts })
        .eq("id", r.reply_row_id);
      try {
        await supabase.from("reply_sends").insert({
          reply_row_id: r.reply_row_id, client_tag: r.client_tag, lead_email: r.to_email,
          message: r.message, status: "sent", error: null,
        });
      } catch { /* table may not exist */ }
      await setStatus(r.id, "done", "sent on retry");
      await logActivity("inbox", "send-reply-retry-sent", {
        client_tag: r.client_tag ?? undefined, lead_email: r.to_email,
        details: { reply_row_id: r.reply_row_id, attempt: r.attempt + 1 },
      });
      sent++;
      continue;
    }

    // Failed again. Reconnect (best-effort) if it's still the SMTP-auth error.
    const reconnectable = isReconnectableSendError(result.error);
    if (reconnectable && r.sender_email) {
      await reconnectInbox(String(r.sender_email), String(r.bison_instance)).catch(() => {});
    }
    // Keep the failure visible on the lead.
    await supabase.from("replies")
      .update({ send_error: result.error || "Send failed", send_error_at: new Date().toISOString() })
      .eq("id", r.reply_row_id)
      .then(() => {}, () => {});

    const nextAttempt = r.attempt + 1;
    // Only keep retrying the reconnect error; a different error → give up.
    if (reconnectable && nextAttempt < BACKOFF_HOURS.length) {
      await db.execute({
        sql: "UPDATE send_reply_retries SET attempt = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
        args: [nextAttempt, hoursFromNow(BACKOFF_HOURS[nextAttempt]), result.error ?? "", new Date().toISOString(), r.id],
      });
      rescheduled++;
    } else {
      await setStatus(r.id, "exhausted", result.error ?? "retry exhausted");
      await logError("inbox", "send-reply-retry-exhausted", result.error ?? "retry exhausted", {
        reply_row_id: r.reply_row_id, client_tag: r.client_tag, attempts: nextAttempt,
      });
      exhausted++;
    }
  }

  return { processed: due.rows.length, sent, rescheduled, exhausted, skipped };
}
