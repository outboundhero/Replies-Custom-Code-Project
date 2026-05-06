import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import supabase from "@/lib/supabase";
import db from "@/lib/db";
import { sendReply, forwardReply, sendOneOffReply, getFirstSentEmail } from "@/lib/outboundhero-api";
import { blacklistDomain, blacklistEmail, isPersonalDomain, extractDomain } from "@/lib/processing/domain-blacklist";
import { pushToSheet, SHEET_PUSH_CATEGORIES } from "@/lib/push-to-sheet";
import { extractRedirectEmail } from "@/lib/processing/extract-redirect-email";
import { logActivity, logError } from "@/lib/errors";

export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const body = await req.json();
    const { action, id } = body;

    switch (action) {
      case "update-category": {
        const { category } = body;
        const { error } = await supabase
          .from("replies")
          .update({ lead_category: category, updated_at: new Date().toISOString() })
          .eq("id", id);
        if (error) throw new Error(error.message);

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
          extras.change_of_target = await handleChangeOfTarget(id);
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
        // Fetch new client's config (CC/BCC/template)
        const configResult = await db.execute({
          sql: "SELECT * FROM client_config WHERE client_tag = ?",
          args: [client_tag],
        });
        const cfg = configResult.rows[0];
        const updateData: Record<string, unknown> = {
          client_tag,
          updated_at: new Date().toISOString(),
        };
        if (cfg) {
          updateData.cc_name_1 = cfg.cc_name_1 ? String(cfg.cc_name_1) : null;
          updateData.cc_email_1 = cfg.cc_email_1 ? String(cfg.cc_email_1) : null;
          updateData.cc_name_2 = cfg.cc_name_2 ? String(cfg.cc_name_2) : null;
          updateData.cc_email_2 = cfg.cc_email_2 ? String(cfg.cc_email_2) : null;
          updateData.cc_name_3 = cfg.cc_name_3 ? String(cfg.cc_name_3) : null;
          updateData.cc_email_3 = cfg.cc_email_3 ? String(cfg.cc_email_3) : null;
          updateData.cc_name_4 = cfg.cc_name_4 ? String(cfg.cc_name_4) : null;
          updateData.cc_email_4 = cfg.cc_email_4 ? String(cfg.cc_email_4) : null;
          updateData.cc_name_5 = cfg.cc_name_5 ? String(cfg.cc_name_5) : null;
          updateData.cc_email_5 = cfg.cc_email_5 ? String(cfg.cc_email_5) : null;
          updateData.cc_name_6 = cfg.cc_name_6 ? String(cfg.cc_name_6) : null;
          updateData.cc_email_6 = cfg.cc_email_6 ? String(cfg.cc_email_6) : null;
          updateData.bcc_name_1 = cfg.bcc_name_1 ? String(cfg.bcc_name_1) : null;
          updateData.bcc_email_1 = cfg.bcc_email_1 ? String(cfg.bcc_email_1) : null;
          updateData.bcc_name_2 = cfg.bcc_name_2 ? String(cfg.bcc_name_2) : null;
          updateData.bcc_email_2 = cfg.bcc_email_2 ? String(cfg.bcc_email_2) : null;
          updateData.our_reply = cfg.reply_template ? String(cfg.reply_template) : null;
        }
        const { error } = await supabase.from("replies").update(updateData).eq("id", id);
        if (error) throw new Error(error.message);
        return NextResponse.json({ ok: true });
      }

      case "send-reply": {
        const { replyId, senderEmailId, message, toEmail, toName, ccEmails, bccEmails } = body;
        const result = await sendReply({ replyId, senderEmailId, message, toEmail, toName, ccEmails, bccEmails });
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
        const result = await forwardReply({ replyId, senderEmailId, message, forwardTo, leadName });
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
        const result = await sendOneOffReply({ senderEmailId, subject, message, toEmail, toName, ccEmails });
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
        await blacklistDomain(email, "manual blacklist", "inbox");
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
async function handleChangeOfTarget(replyId: number): Promise<ChangeOfTargetResult> {
  try {
    const { data: reply, error } = await supabase
      .from("replies")
      .select("lead_id, lead_email, lead_name, reply_we_got, client_tag, workflow")
      .eq("id", replyId)
      .single();

    if (error || !reply) {
      return { ok: false, reason: "Reply not found in Supabase" };
    }

    const leadId = reply.lead_id as number | null;
    const originalLeadEmail = (reply.lead_email as string | null) || "";
    const replyBody = (reply.reply_we_got as string | null) || "";

    if (!leadId) {
      return { ok: false, reason: "No lead_id on this reply — was an untracked reply?" };
    }
    if (!replyBody.trim()) {
      return { ok: false, reason: "Reply body is empty — nothing to extract from" };
    }

    // 1. AI extracts the new contact email + name from the reply.
    const extracted = await extractRedirectEmail(replyBody, originalLeadEmail);
    if (!extracted.email) {
      return { ok: false, reason: "Could not find an alternative contact email in the reply" };
    }

    // 2. Fetch the very first cold email we sent to the original lead.
    const firstEmail = await getFirstSentEmail(leadId);
    if (!firstEmail) {
      return { ok: false, reason: `No sent emails found for lead ${leadId}` };
    }
    if (!firstEmail.sender_email?.id) {
      return { ok: false, reason: "First sent email has no sender_email — cannot re-send" };
    }

    // 3. Send the same subject + body to the new contact via /replies/new.
    const send = await sendOneOffReply({
      senderEmailId: firstEmail.sender_email.id,
      subject: firstEmail.email_subject || "(no subject)",
      message: firstEmail.email_body || "",
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
          new_email: extracted.email,
          new_name: extracted.name,
          first_email_id: firstEmail.id,
          first_email_subject: firstEmail.email_subject,
          first_email_sent_at: firstEmail.sent_at,
          sender_email_id: firstEmail.sender_email.id,
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
