/**
 * GET /api/cron/auto-reply-not-interested
 *
 * Drains the queue of replies that were marked "Not Interested (Send Reply)"
 * 5–10 minutes ago and haven't yet had their polite acknowledgment sent.
 *
 * Schedule: every 2 minutes (vercel.json — see "*\/2 * * * *"). Combined
 * with the 5–10 minute delay, real-world latency is ~6–12 minutes after
 * the user clicks the category in the inbox.
 *
 * Auth: requires CRON_SECRET (same pattern as the other crons). Vercel
 * cron sends "Authorization: Bearer <CRON_SECRET>".
 *
 * Each run is bounded by maxDuration. Anything we don't get to comes back
 * on the next run because auto_reply_sent_at is still NULL.
 */

import { NextRequest, NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { sendReply } from "@/lib/outboundhero-api";
import { buildNotInterestedReply } from "@/lib/processing/not-interested-reply";
import { logActivity, logError } from "@/lib/errors";

// Each send is one OB API call (~300–800ms). Cap batch at 50 → fits well
// inside 60s with margin for slow replies.
export const maxDuration = 60;

interface DueRow {
  id: number;
  reply_id: number | null;
  sender_id: number | null;
  lead_email: string | null;
  lead_name: string | null;
  sender_name: string | null;
  cc_name_1: string | null; cc_email_1: string | null;
  cc_name_2: string | null; cc_email_2: string | null;
  cc_name_3: string | null; cc_email_3: string | null;
  cc_name_4: string | null; cc_email_4: string | null;
  cc_name_5: string | null; cc_email_5: string | null;
  cc_name_6: string | null; cc_email_6: string | null;
  bcc_name_1: string | null; bcc_email_1: string | null;
  bcc_name_2: string | null; bcc_email_2: string | null;
}

function collectRecipients(row: DueRow, prefix: "cc" | "bcc"): { name: string; email_address: string }[] {
  const max = prefix === "cc" ? 6 : 2;
  const out: { name: string; email_address: string }[] = [];
  for (let i = 1; i <= max; i++) {
    const email = (row[`${prefix}_email_${i}` as keyof DueRow] as string | null)?.trim();
    if (!email) continue;
    const name = (row[`${prefix}_name_${i}` as keyof DueRow] as string | null)?.trim() || "";
    out.push({ name, email_address: email });
  }
  return out;
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
      "id, reply_id, sender_id, lead_email, lead_name, sender_name, " +
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
    console.error("[cron/auto-reply-not-interested] select failed:", error);
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
    const row = rowRaw as DueRow;

    // Required fields to send an in-thread reply via OB.
    if (!row.reply_id || !row.sender_id || !row.lead_email) {
      // Mark as "sent" with an error log so we don't keep re-scanning.
      await supabase
        .from("replies")
        .update({ auto_reply_sent_at: new Date().toISOString() })
        .eq("id", row.id);
      await logError("inbox", "not-interested-auto-reply", "missing reply_id, sender_id or lead_email", { row_id: row.id });
      skipped++;
      continue;
    }

    const plainText = buildNotInterestedReply(row.lead_name, row.sender_name);
    // OB content_type is "html" — convert newlines to <br>.
    const htmlMessage = plainText.replace(/\n/g, "<br>");

    const ccEmails = collectRecipients(row, "cc");
    const bccEmails = collectRecipients(row, "bcc");

    const result = await sendReply({
      replyId: row.reply_id,
      senderEmailId: row.sender_id,
      message: htmlMessage,
      toEmail: row.lead_email,
      toName: row.lead_name || "",
      ccEmails: ccEmails.length ? ccEmails : undefined,
      bccEmails: bccEmails.length ? bccEmails : undefined,
    });

    if (result.ok) {
      await supabase
        .from("replies")
        .update({
          auto_reply_sent_at: new Date().toISOString(),
          sent_reply: plainText,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      await logActivity("inbox", "not-interested-auto-reply-sent", {
        lead_email: row.lead_email,
        details: { reply_id: row.reply_id, lead_name: row.lead_name, sender_name: row.sender_name },
      });
      sent++;
    } else {
      await logError("inbox", "not-interested-auto-reply", result.error || "sendReply !ok", {
        row_id: row.id,
        reply_id: row.reply_id,
        lead_email: row.lead_email,
      });
      failed++;
      failures.push({ id: row.id, reason: result.error || "send failed" });
    }
  }

  return NextResponse.json({ ok: true, processed: due.length, sent, skipped, failed, failures });
}
