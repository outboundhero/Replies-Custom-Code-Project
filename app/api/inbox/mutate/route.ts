import { NextRequest, NextResponse } from "next/server";
import { requireAuth, getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { sendReply, forwardReply, sendOneOffReply, getFirstSentEmail } from "@/lib/outboundhero-api";
import { blacklistDomain, blacklistEmail, isPersonalDomain, extractDomain } from "@/lib/processing/domain-blacklist";
import { pushToSheet, SHEET_PUSH_CATEGORIES } from "@/lib/push-to-sheet";
import { pushToGhl, isGhlPushCategory } from "@/lib/push-to-ghl";
import { extractRedirectEmail } from "@/lib/processing/extract-redirect-email";
import { extractReturnDate } from "@/lib/processing/extract-return-date";
import { logActivity, logError } from "@/lib/errors";
import { coerceInstance, DEFAULT_INSTANCE } from "@/lib/bison-instances";
import { bumpCacheVersion } from "@/lib/inbox-cache";
import { applyReallocate } from "@/lib/processing/apply-reallocate";

export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const body = await req.json();
    const { action, id } = body;

    // Per-user client scoping + per-row instance lookup. Both rely on the
    // same row, so fetch once. `rowInstance` is the Bison instance every
    // outgoing API call in this handler should target — it's the only
    // instance this row's IDs (sender_id, reply_id, campaign_id) are
    // valid on.
    let rowInstance: string = DEFAULT_INSTANCE;
    if (id) {
      const session = await getSession();
      const allowed = session?.allowedClientTags ?? null;
      const { data: row } = await supabase
        .from("replies")
        .select("client_tag, bison_instance")
        .eq("id", id)
        .single();
      if (allowed && allowed.length) {
        if (!row || !row.client_tag || !allowed.includes(row.client_tag)) {
          return NextResponse.json({ error: "Not found" }, { status: 404 });
        }
      }
      rowInstance = coerceInstance(row?.bison_instance);
    }

    switch (action) {
      case "update-category": {
        const { category } = body;
        const { error } = await supabase
          .from("replies")
          .update({ lead_category: category, updated_at: new Date().toISOString() })
          .eq("id", id);
        if (error) throw new Error(error.message);
        // Counts cache stale now — category moved between buckets.
        bumpCacheVersion();

        // Side-effect outputs accumulated below, then merged into the
        // single final response so the client can show one toast.
        const extras: Record<string, unknown> = {};

        // Manual DNC also blacklists the email in OutboundHero — same
        // behavior the auto-categorizer applies in tracked.ts/untracked.ts
        // so a lead can't be marked DNC in the inbox and still receive
        // future outbound.
        if (category === "Do Not Contact") {
          const { data: reply } = await supabase
            .from("replies")
            .select("lead_email, client_tag, workflow")
            .eq("id", id)
            .single();
          if (reply?.lead_email) {
            await blacklistEmail(
              rowInstance,
              reply.lead_email,
              (reply.workflow as string) || "inbox",
              { client_tag: reply.client_tag as string | undefined },
            );
          }
        }

        // Change Of Target → re-pitch the original cold email to the
        // contact the lead redirected us to (extract new email from the
        // reply, fetch the first sent email, send it via /replies/new).
        if (category === "Change Of Target") {
          extras.change_of_target = await handleChangeOfTarget(id, rowInstance);
        }

        // Not Interested (Send Reply) → schedule a polite acknowledgment
        // for 5–10 minutes from now. The /api/cron/auto-reply job (every
        // 2 minutes) drains pending rows and replies in-thread. Random
        // delay keeps the cadence human.
        if (category === "Not Interested (Send Reply)") {
          const delayMs = (5 + Math.random() * 5) * 60 * 1000;
          const dueAt = new Date(Date.now() + delayMs).toISOString();
          const { error: schedErr } = await supabase
            .from("replies")
            .update({
              auto_reply_due_at: dueAt,
              auto_reply_kind: "not_interested",
              auto_reply_sent_at: null,
            })
            .eq("id", id);
          if (schedErr) extras.auto_reply_schedule_error = schedErr.message;
          else extras.auto_reply_due_at = dueAt;
        }

        // Out Of Office → AI extracts the return date from the reply,
        // then the auto-reply cron sends the original first cold email
        // back to the lead on that date with a "Looks like you are back…"
        // intro. If the AI can't pin a date, we skip scheduling and tell
        // the user — categorization itself still succeeds.
        if (category === "Out Of Office") {
          const { data: ooReply } = await supabase
            .from("replies")
            .select("reply_we_got")
            .eq("id", id)
            .single();
          const replyText = (ooReply?.reply_we_got as string | null) || "";
          const returnDate = await extractReturnDate(replyText);
          if (!returnDate) {
            extras.out_of_office_return_date = null;
            extras.out_of_office_reason = "No clear return date found in the reply — auto-reschedule skipped.";
          } else {
            // Fire at 09:00 PT on the return date so the lead sees it
            // first thing Monday morning rather than at midnight.
            const dueAt = new Date(`${returnDate}T16:00:00Z`).toISOString(); // 09:00 PDT = 16:00 UTC
            const { error: schedErr } = await supabase
              .from("replies")
              .update({
                auto_reply_due_at: dueAt,
                auto_reply_kind: "out_of_office",
                auto_reply_sent_at: null,
              })
              .eq("id", id);
            if (schedErr) extras.auto_reply_schedule_error = schedErr.message;
            else {
              extras.out_of_office_return_date = returnDate;
              extras.auto_reply_due_at = dueAt;
            }
          }
        }

        // Auto-push to Google Sheet for qualifying categories
        if (SHEET_PUSH_CATEGORIES.some((c) => c.toLowerCase() === category?.toLowerCase())) {
          const { data: reply } = await supabase.from("replies").select("*").eq("id", id).single();
          if (reply && reply.client_tag && reply.client_tag !== "N/A") {
            const result = await pushToSheet(reply.client_tag, {
              lead_email: reply.lead_email || "",
              lead_name: reply.lead_name || "",
              company_name: reply.company_name || "",
              reply_time: reply.reply_time || "",
              city: reply.city || "",
              state: reply.state || "",
              address: reply.address || "",
              google_maps_url: reply.google_maps_url || "",
              phone: reply.phone || "",
              lead_category: category,
              client_tag: reply.client_tag || "",
              sender_email: reply.sender_email || "",
              reply_we_got: reply.reply_we_got || "",
              prospect_cc_email: reply.prospect_cc_email || "",
              our_reply: reply.our_reply || "",
              cc_email_1: reply.cc_email_1 || "",
              cc_email_2: reply.cc_email_2 || "",
              cc_email_3: reply.cc_email_3 || "",
              bcc_email_1: reply.bcc_email_1 || "",
              notes: reply.notes || "",
            });
            if (result.ok) {
              await supabase.from("replies").update({
                pushed_to_sheet: true,
                pushed_to_sheet_at: new Date().toISOString(),
              }).eq("id", id);
            }
            extras.pushed_to_sheet = result.ok;
            if (result.error) extras.sheet_error = result.error;
          }
        }

        // Auto-push to the client's GoHighLevel sub-account for qualifying
        // categories — only fires for clients with GHL creds configured in
        // client_config (pushToGhl returns a no-op otherwise). Upsert dedupes
        // on email, so re-marking updates the existing contact.
        if (isGhlPushCategory(category)) {
          const { data: reply } = await supabase.from("replies").select("*").eq("id", id).single();
          if (reply && reply.client_tag && reply.client_tag !== "N/A") {
            const result = await pushToGhl(reply.client_tag, {
              lead_email: reply.lead_email,
              first_name: reply.first_name,
              last_name: reply.last_name,
              lead_name: reply.lead_name,
              company_name: reply.company_name,
              phone: reply.phone,
              address: reply.address,
              city: reply.city,
              state: reply.state,
              lead_category: category,
              bison_instance: reply.bison_instance,
            });
            if (result.ok) {
              // Audit columns are optional; if they don't exist this is a
              // harmless no-op (Supabase returns an error we don't read).
              await supabase.from("replies").update({
                pushed_to_ghl: true,
                pushed_to_ghl_at: new Date().toISOString(),
              }).eq("id", id);
              extras.pushed_to_ghl = true;
            } else if (result.error && !result.error.startsWith("no GHL config")) {
              extras.ghl_error = result.error;
            }
          }
        }
        return NextResponse.json({ ok: true, ...extras });
      }

      case "update-notes": {
        const { notes } = body;
        const { error } = await supabase
          .from("replies")
          .update({ notes, updated_at: new Date().toISOString() })
          .eq("id", id);
        if (error) throw new Error(error.message);
        return NextResponse.json({ ok: true });
      }

      case "update-cc": {
        const { cc_name_1, cc_email_1, cc_name_2, cc_email_2, cc_name_3, cc_email_3,
          cc_name_4, cc_email_4, cc_name_5, cc_email_5, cc_name_6, cc_email_6,
          bcc_name_1, bcc_email_1, bcc_name_2, bcc_email_2 } = body;
        const { error } = await supabase
          .from("replies")
          .update({
            cc_name_1, cc_email_1, cc_name_2, cc_email_2, cc_name_3, cc_email_3,
            cc_name_4, cc_email_4, cc_name_5, cc_email_5, cc_name_6, cc_email_6,
            bcc_name_1, bcc_email_1, bcc_name_2, bcc_email_2,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);
        if (error) throw new Error(error.message);
        return NextResponse.json({ ok: true });
      }

      case "reallocate": {
        const { client_tag } = body;
        const result = await applyReallocate(id, client_tag);
        if (!result.ok) throw new Error(result.error);
        return NextResponse.json({ ok: true });
      }

      case "send-reply": {
        const { replyId, senderEmailId, message, toEmail, toName, ccEmails, bccEmails } = body;
        const result = await sendReply(rowInstance, { replyId, senderEmailId, message, toEmail, toName, ccEmails, bccEmails });
        if (result.ok) {
          await supabase.from("replies").update({
            sent_reply: message,
            updated_at: new Date().toISOString(),
          }).eq("id", id);
        }
        return NextResponse.json(result);
      }

      case "forward": {
        const { replyId, senderEmailId, message, forwardTo, leadName } = body;
        const result = await forwardReply(rowInstance, { replyId, senderEmailId, message, forwardTo, leadName });
        if (result.ok) {
          await supabase.from("replies").update({
            forwarded_to: forwardTo,
            forwarded_status: "Forwarded",
            updated_at: new Date().toISOString(),
          }).eq("id", id);
        }
        return NextResponse.json(result);
      }

      case "send-one-off": {
        const { senderEmailId, subject, message, toEmail, toName, ccEmails } = body;
        const result = await sendOneOffReply(rowInstance, { senderEmailId, subject, message, toEmail, toName, ccEmails });
        return NextResponse.json(result);
      }

      case "blacklist-domain": {
        const { email } = body;
        const domain = extractDomain(email || "");
        if (!domain) {
          return NextResponse.json({ error: "Invalid email — no domain to blacklist" }, { status: 400 });
        }
        // Hard-stop personal mailbox providers server-side too — even if
        // somehow the UI guard is bypassed, blacklisting gmail.com /
        // outlook.com etc. would break us for every legitimate prospect.
        if (isPersonalDomain(domain)) {
          return NextResponse.json(
            { error: `Cannot blacklist ${domain} — it's a personal email provider. Blacklist the address instead.` },
            { status: 400 },
          );
        }
        await blacklistDomain(rowInstance, email, "manual blacklist", "inbox");
        return NextResponse.json({ ok: true });
      }

      case "push-to-sheet": {
        const { data: reply } = await supabase.from("replies").select("*").eq("id", id).single();
        if (!reply) return NextResponse.json({ error: "Reply not found" }, { status: 404 });
        if (!reply.client_tag || reply.client_tag === "N/A") {
          return NextResponse.json({ error: "Cannot push N/A client to sheet" }, { status: 400 });
        }
        const result = await pushToSheet(reply.client_tag, {
          lead_email: reply.lead_email || "",
          lead_name: reply.lead_name || "",
          company_name: reply.company_name || "",
          reply_time: reply.reply_time || "",
          city: reply.city || "",
          state: reply.state || "",
          address: reply.address || "",
          google_maps_url: reply.google_maps_url || "",
          phone: reply.phone || "",
          lead_category: reply.lead_category || "",
          client_tag: reply.client_tag || "",
          sender_email: reply.sender_email || "",
          reply_we_got: reply.reply_we_got || "",
          prospect_cc_email: reply.prospect_cc_email || "",
          our_reply: reply.our_reply || "",
          cc_email_1: reply.cc_email_1 || "",
          cc_email_2: reply.cc_email_2 || "",
          cc_email_3: reply.cc_email_3 || "",
          bcc_email_1: reply.bcc_email_1 || "",
          notes: reply.notes || "",
        });
        if (result.ok) {
          await supabase.from("replies").update({
            pushed_to_sheet: true,
            pushed_to_sheet_at: new Date().toISOString(),
          }).eq("id", id);
        }
        return NextResponse.json(result);
      }

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    console.error("[api/inbox/mutate] POST failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

/** Escape user-supplied strings before inlining into the wrapped HTML
 *  email so a stray `<` in someone's name can't break the body. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface ChangeOfTargetResult {
  ok: boolean;
  reason?: string;       // why it didn't ok (no lead_id, no email in reply, etc.)
  new_email?: string;
  new_name?: string;
  first_email_subject?: string;
  first_email_sent_at?: string;
}

/**
 * Re-pitch the original cold email to the contact a Change-of-Target
 * reply directs us to. Pure side-effect — never throws; the caller
 * surfaces the result to the inbox UI.
 *
 * Failures are logged to error_log so the user sees them on /errors and
 * can retry manually if needed.
 */
async function handleChangeOfTarget(replyId: number, instanceKey: string): Promise<ChangeOfTargetResult> {
  try {
    const { data: reply, error } = await supabase
      .from("replies")
      .select("lead_id, lead_email, lead_name, reply_we_got, client_tag, workflow, campaign_id")
      .eq("id", replyId)
      .single();

    if (error || !reply) {
      return { ok: false, reason: "Reply not found in Supabase" };
    }

    const leadId = reply.lead_id as number | null;
    const campaignId = (reply.campaign_id as number | null) ?? null;
    const originalLeadEmail = (reply.lead_email as string | null) || "";
    const replyBody = (reply.reply_we_got as string | null) || "";

    if (!leadId) {
      return { ok: false, reason: "No lead_id on this reply — was an untracked reply?" };
    }
    if (!campaignId) {
      return { ok: false, reason: "No campaign_id on this reply — can't scope the cold email lookup to the correct campaign" };
    }
    if (!replyBody.trim()) {
      return { ok: false, reason: "Reply body is empty — nothing to extract from" };
    }

    // 1. AI extracts the new contact email + name from the reply.
    const extracted = await extractRedirectEmail(replyBody, originalLeadEmail);
    if (!extracted.email) {
      return { ok: false, reason: "Could not find an alternative contact email in the reply" };
    }

    // 2. Fetch the FIRST cold email we sent to this lead within the SAME
    // campaign the reply belongs to. A lead can sit in multiple
    // campaigns over time and we need to mirror the cold email from the
    // exact one this reply came from — not some unrelated older outreach.
    const firstEmail = await getFirstSentEmail(instanceKey, leadId, campaignId);
    if (!firstEmail) {
      return { ok: false, reason: `No sent emails found for lead ${leadId} in campaign ${campaignId}` };
    }
    if (!firstEmail.sender_email?.id) {
      return { ok: false, reason: "First sent email has no sender_email — cannot re-send" };
    }

    // 3. Wrap the original cold email with context so the new contact
    //    knows why they're getting it, and send to them via /replies/new.
    //
    //    Earlier version blasted the raw cold body — the new contact had
    //    no idea where it came from or why. Now we frame it: who pointed
    //    us to them (original lead's name), then quote the original
    //    email below, signed off with the original sender's name.
    const newContactFirstName =
      (extracted.name || "").trim().split(/\s+/)[0] || "there";
    const originalLeadDisplayName =
      ((reply.lead_name as string | null) || "").trim() || originalLeadEmail || "the lead we contacted";
    const senderName = (firstEmail.sender_email.name || "").trim() || "the team";

    const wrappedMessage =
      `<p>Hi ${escapeHtml(newContactFirstName)},</p>` +
      `<p>We received your email from ${escapeHtml(originalLeadDisplayName)} — here's the email we sent them:</p>` +
      `<hr style="margin:16px 0;border:0;border-top:1px solid #ddd;">` +
      (firstEmail.email_body || "") +
      `<hr style="margin:16px 0;border:0;border-top:1px solid #ddd;">` +
      `<p>Let me know,</p>` +
      `<p>${escapeHtml(senderName)}</p>`;

    const send = await sendOneOffReply(instanceKey, {
      senderEmailId: firstEmail.sender_email.id,
      subject: firstEmail.email_subject || "(no subject)",
      message: wrappedMessage,
      toEmail: extracted.email,
      toName: extracted.name || "",
    });

    if (!send.ok) {
      await logError(
        (reply.workflow as string) || "inbox",
        "change-of-target",
        send.error || "sendOneOffReply returned !ok",
        {
          reply_id: replyId,
          lead_id: leadId,
          original_lead_email: originalLeadEmail,
          new_email: extracted.email,
          first_sent_email_id: firstEmail.id,
        },
      );
      return {
        ok: false,
        reason: `Send failed: ${send.error || "unknown"}`,
        new_email: extracted.email,
        new_name: extracted.name || undefined,
        first_email_subject: firstEmail.email_subject,
        first_email_sent_at: firstEmail.sent_at || undefined,
      };
    }

    await logActivity(
      (reply.workflow as string) || "inbox",
      "change-of-target-sent",
      {
        client_tag: (reply.client_tag as string | undefined) || undefined,
        lead_email: originalLeadEmail,
        details: {
          reply_id: replyId,
          campaign_id: campaignId,
          new_email: extracted.email,
          new_name: extracted.name,
          first_email_id: firstEmail.id,
          first_email_subject: firstEmail.email_subject,
          first_email_sent_at: firstEmail.sent_at,
          sender_email_id: firstEmail.sender_email.id,
          bison_instance: instanceKey,
        },
      },
    );

    return {
      ok: true,
      new_email: extracted.email,
      new_name: extracted.name || undefined,
      first_email_subject: firstEmail.email_subject,
      first_email_sent_at: firstEmail.sent_at || undefined,
    };
  } catch (e) {
    await logError("inbox", "change-of-target", (e as Error).message || "unknown", {
      reply_id: replyId,
    });
    return { ok: false, reason: (e as Error).message || "unknown error" };
  }
}
