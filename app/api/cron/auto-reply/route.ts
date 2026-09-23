/**
 * GET /api/cron/auto-reply
 *
 * Drains the queue of replies that need a scheduled in-thread reply sent.
 * Two kinds, both stored in the same `replies.auto_reply_*` columns and
 * dispatched here:
 *
 *   - "not_interested" → polite acknowledgment 5–10 min after the user
 *     marks the lead "Not Interested (Send Reply)". Body is built locally.
 *   - "out_of_office"  → on the lead's stated return date, re-send the
 *     original first cold email (same campaign) with a "Looks like you
 *     are back" intro.
 *
 * Schedule: every 2 minutes (vercel.json: "*\/2 * * * *"). Combined with
 * the kind-specific delays, real-world latency:
 *   not_interested → 6–12 min after categorization
 *   out_of_office  → fired at 09:00 PT on the return date, ±2 min
 *
 * Auth: requires CRON_SECRET. Vercel cron sends it as
 * "Authorization: Bearer <CRON_SECRET>".
 *
 * Each run is bounded by maxDuration. Anything we don't get to comes back
 * on the next run because auto_reply_sent_at stays NULL until success.
 *
 * Safety: we re-check `lead_category` per row before sending. If the user
 * recategorized between scheduling and the cron run, we skip — no point
 * sending a "Not Interested" template to a lead now marked Interested.
 */

import { NextRequest, NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { sendReply, getFirstSentEmail } from "@/lib/outboundhero-api";
import { buildNotInterestedReply } from "@/lib/processing/not-interested-reply";
import { htmlToText } from "@/lib/html-text";
import { logActivity, logError } from "@/lib/errors";
import { coerceInstance } from "@/lib/bison-instances";

export const maxDuration = 60;

interface DueRow {
  id: number;
  reply_id: number | null;
  sender_id: number | null;
  lead_id: number | null;
  campaign_id: number | null;
  lead_email: string | null;
  lead_name: string | null;
  sender_name: string | null;
  lead_category: string | null;
  auto_reply_kind: string | null;
  auto_reply_due_at: string | null;
  bison_instance: string | null;
  cc_name_1: string | null; cc_email_1: string | null;
  cc_name_2: string | null; cc_email_2: string | null;
  cc_name_3: string | null; cc_email_3: string | null;
  cc_name_4: string | null; cc_email_4: string | null;
  cc_name_5: string | null; cc_email_5: string | null;
  cc_name_6: string | null; cc_email_6: string | null;
  bcc_name_1: string | null; bcc_email_1: string | null;
  bcc_name_2: string | null; bcc_email_2: string | null;
}

/** Decide whether a row is still safe to auto-reply on. */
function categoryStillMatchesKind(row: DueRow): boolean {
  const cat = row.lead_category;
  // Legacy rows scheduled before auto_reply_kind existed default to
  // "not_interested" (the only kind that existed at the time).
  const kind = row.auto_reply_kind || "not_interested";
  if (kind === "not_interested") return cat === "Not Interested (Send Reply)";
  if (kind === "out_of_office")  return cat === "Out Of Office";
  return false;
}

interface BuildResult {
  message: string;        // HTML body to send
  plainSummary: string;   // What we mirror into replies.sent_reply for the inbox UI
}

/**
 * Bison errors come back as "${status}: ${body}" from outboundhero-api.ts.
 * Some statuses are permanent — retrying tomorrow won't help and just
 * generates duplicate error logs every 2 minutes. Detect those and drain
 * the row so the queue stops looping on it.
 *
 * - 400 / 422 → malformed request or invalid resource id (e.g. the sender
 *   mailbox was disconnected, so `sender_email_id` is now invalid)
 * - 401 / 403 → token revoked / forbidden — the instance config is broken,
 *   draining stops the storm; will need a separate fix to restore sending
 * - 404 / 410 → the reply, lead, or campaign no longer exists on Bison
 *
 * Anything else (429 rate limit, 5xx server-side, network) stays in the
 * retry pool because it legitimately gets better on the next run.
 */
function isPermanentSendError(error: string | undefined): boolean {
  if (!error) return false;
  const status = parseInt(error.split(":")[0]?.trim() || "", 10);
  if (Number.isNaN(status)) return false;
  return status === 400 || status === 401 || status === 403
      || status === 404 || status === 410 || status === 422;
}

/**
 * Expected, NON-ACTIONABLE outcomes of an AUTOMATED OOO / not-interested send.
 * These are operational/data conditions, not code faults:
 *   - build skip: the reply is untracked (no lead_id / campaign_id) or has no
 *     prior sent email, so there's nothing to re-send.
 *   - send fail: the sender mailbox was disconnected/removed on Bison since the
 *     reply came in ("selected sender email id is invalid"), or the reply/lead/
 *     campaign no longer exists (404/410).
 * The row is drained either way; we record a quiet activity note instead of an
 * Error Log entry so the log isn't flooded with routine mailbox-churn noise.
 * Genuine problems (auth revoked, unknown kind, other 4xx) still log as errors.
 */
function isExpectedBuildSkip(reason: string): boolean {
  return /missing lead_id|missing campaign_id|no sent emails/i.test(reason);
}
function isExpectedSendFailure(error: string | undefined): boolean {
  if (!error) return false;
  const status = parseInt(error.split(":")[0]?.trim() || "", 10);
  if (status === 404 || status === 410) return true;            // reply/lead/campaign gone
  return /selected sender email id is invalid|sender_email_id/i.test(error); // mailbox disconnected
}

async function buildBodyForKind(row: DueRow, instanceKey: string): Promise<{ ok: true; build: BuildResult } | { ok: false; reason: string }> {
  const kind = row.auto_reply_kind || "not_interested";

  // NOTE: sendReply() runs `message` through plainTextToEmailHtml() (escapes
  // <>&, linkifies, newlines→<br>) and sends content_type:"html". So `message`
  // MUST be PLAIN TEXT — passing HTML here double-escapes it and the recipient
  // sees literal <p>/<br> tags. (This was the OOO/not-interested tag bug.)
  if (kind === "not_interested") {
    const plain = buildNotInterestedReply(row.lead_name, row.sender_name);
    return { ok: true, build: { message: plain, plainSummary: plain } };
  }

  if (kind === "out_of_office") {
    if (!row.lead_id) return { ok: false, reason: "missing lead_id (untracked reply?)" };
    if (!row.campaign_id) return { ok: false, reason: "missing campaign_id" };

    const firstEmail = await getFirstSentEmail(instanceKey, row.lead_id, row.campaign_id);
    if (!firstEmail) return { ok: false, reason: `no sent emails for lead ${row.lead_id} in campaign ${row.campaign_id}` };

    // The original cold email body is HTML — convert to plain text so sendReply's
    // HTML conversion renders it correctly (instead of escaping its tags).
    const introPlain = "Looks like you are back, so I am sending the initial email again.";
    const bodyPlain = htmlToText(firstEmail.email_body || "");
    const message = `${introPlain}\n\n${bodyPlain}`;
    const plainSummary = `${introPlain}\n\n${firstEmail.email_subject || "(original cold email)"}`;
    return { ok: true, build: { message, plainSummary } };
  }

  return { ok: false, reason: `unknown auto_reply_kind="${kind}"` };
}

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const nowIso = new Date().toISOString();

  const { data: due, error } = await supabase
    .from("replies")
    .select(
      "id, reply_id, sender_id, lead_id, campaign_id, lead_email, lead_name, sender_name, " +
      "lead_category, auto_reply_kind, auto_reply_due_at, bison_instance, email_subject, " +
      "cc_name_1, cc_email_1, cc_name_2, cc_email_2, cc_name_3, cc_email_3, " +
      "cc_name_4, cc_email_4, cc_name_5, cc_email_5, cc_name_6, cc_email_6, " +
      "bcc_name_1, bcc_email_1, bcc_name_2, bcc_email_2"
    )
    .lte("auto_reply_due_at", nowIso)
    .is("auto_reply_sent_at", null)
    .not("auto_reply_due_at", "is", null)
    .order("auto_reply_due_at", { ascending: true })
    .limit(50);

  if (error) {
    console.error("[cron/auto-reply] select failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!due || due.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const failures: Array<{ id: number; reason: string }> = [];

  for (const rowRaw of due) {
    // Supabase's typed-string parser doesn't recognise this many columns
    // in one .select() so it returns GenericStringError; cast through
    // unknown to land back on our concrete shape.
    const row = rowRaw as unknown as DueRow;
    const kind = row.auto_reply_kind || "not_interested";

    // Skip if the user recategorized the lead between scheduling and now —
    // no point sending the wrong template.
    if (!categoryStillMatchesKind(row)) {
      await supabase
        .from("replies")
        .update({ auto_reply_sent_at: new Date().toISOString() })
        .eq("id", row.id);
      skipped++;
      continue;
    }

    if (!row.reply_id || !row.sender_id || !row.lead_email) {
      await supabase
        .from("replies")
        .update({ auto_reply_sent_at: new Date().toISOString() })
        .eq("id", row.id);
      await logError("inbox", `${kind}-auto-reply`, "missing reply_id, sender_id or lead_email", { row_id: row.id });
      skipped++;
      continue;
    }

    // Per-row instance routing. The row's IDs (sender_id, reply_id,
    // campaign_id) are only valid on the instance the reply originally
    // came from — that's stamped on row.bison_instance at webhook time.
    const instanceKey = coerceInstance(row.bison_instance);

    const built = await buildBodyForKind(row, instanceKey);
    if (!built.ok) {
      if (isExpectedBuildSkip(built.reason)) {
        await logActivity("inbox", `${kind}-auto-reply-skipped`, { lead_email: row.lead_email ?? undefined, details: { row_id: row.id, reason: built.reason, bison_instance: instanceKey } });
      } else {
        await logError("inbox", `${kind}-auto-reply`, `build skipped: ${built.reason}`, { row_id: row.id, bison_instance: instanceKey });
      }
      // Mark sent so we don't loop on a permanently-broken row.
      await supabase
        .from("replies")
        .update({ auto_reply_sent_at: new Date().toISOString() })
        .eq("id", row.id);
      skipped++;
      continue;
    }

    // Do NOT loop in the client's CC/BCC on these automated sends. Both kinds go
    // to the LEAD, not the client: out_of_office re-sends the original cold email
    // (outbound prospecting), and not_interested is a polite rejection ack. The
    // client's CC/BCC gets stamped onto the row at ingest for CC/BCC-eligible AI
    // categories (incl. "Unrecognizable by AI", which OOO replies often land in),
    // so reusing it here would CC the client on our own prospecting — which is
    // exactly the bug clients reported (e.g. being CC'd on an OOO "welcome back"
    // re-send). CC/BCC is only for genuine positive-engagement replies.
    const ccEmails: { name: string; email_address: string }[] = [];
    const bccEmails: { name: string; email_address: string }[] = [];

    const result = await sendReply(instanceKey, {
      replyId: row.reply_id,
      senderEmailId: row.sender_id,
      message: built.build.message,
      toEmail: row.lead_email,
      toName: row.lead_name || "",
      ccEmails: ccEmails.length ? ccEmails : undefined,
      bccEmails: bccEmails.length ? bccEmails : undefined,
      subject: (row as { email_subject?: string | null }).email_subject ?? undefined,
      leadId: (row as { lead_id?: number | null }).lead_id ?? undefined,
    });

    if (result.ok) {
      await supabase
        .from("replies")
        .update({
          auto_reply_sent_at: new Date().toISOString(),
          sent_reply: built.build.plainSummary,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      await logActivity("inbox", `${kind}-auto-reply-sent`, {
        lead_email: row.lead_email,
        details: { reply_id: row.reply_id, kind, bison_instance: instanceKey, lead_name: row.lead_name, sender_name: row.sender_name },
      });
      sent++;
    } else {
      const permanent = isPermanentSendError(result.error);
      if (isExpectedSendFailure(result.error)) {
        // Disconnected/removed sender mailbox (or deleted resource) — routine
        // churn for an automated re-send, not an actionable error. Log quietly.
        await logActivity("inbox", `${kind}-auto-reply-skipped`, { lead_email: row.lead_email ?? undefined, details: { row_id: row.id, reason: result.error, bison_instance: instanceKey } });
      } else {
        await logError("inbox", `${kind}-auto-reply`, result.error || "sendReply !ok", {
          row_id: row.id,
          reply_id: row.reply_id,
          lead_email: row.lead_email,
          bison_instance: instanceKey,
          permanent,
        });
      }
      // Permanent failures (disconnected sender, deleted resource, revoked
      // token) never get better on retry — drain the row so the 2-min cron
      // doesn't re-log the same error forever.
      if (permanent) {
        await supabase
          .from("replies")
          .update({ auto_reply_sent_at: new Date().toISOString() })
          .eq("id", row.id);
      }
      failed++;
      failures.push({ id: row.id, reason: result.error || "send failed" });
    }
  }

  return NextResponse.json({ ok: true, processed: due.length, sent, skipped, failed, failures });
}
