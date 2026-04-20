import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { sendReply, forwardReply, sendOneOffReply } from "@/lib/outboundhero-api";
import { blacklistDomain } from "@/lib/processing/domain-blacklist";
import { pushToSheet, SHEET_PUSH_CATEGORIES } from "@/lib/push-to-sheet";

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
            return NextResponse.json({ ok: true, pushed_to_sheet: result.ok, sheet_error: result.error });
          }
        }
        return NextResponse.json({ ok: true });
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
        const { error } = await supabase
          .from("replies")
          .update({ client_tag, updated_at: new Date().toISOString() })
          .eq("id", id);
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
        const domain = email?.split("@")[1];
        if (domain) {
          await blacklistDomain(email, "manual blacklist", "inbox");
        }
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
