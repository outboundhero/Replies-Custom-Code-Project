/**
 * Single source of truth for pushing a reply to its client's lead-tracking
 * sheet — used by manual categorize, the manual "push to sheet" button, the
 * retry endpoint, and the auto-retry cron so they all behave identically:
 *
 *   success → stamp pushed_to_sheet + clear any recorded failure
 *   failure → record a durable failure for the Sheet Pushes dashboard
 *
 * pushToSheet itself already retries transient Google API errors; this layer
 * adds the persistence so a lead can never be silently lost.
 */
import supabase from "@/lib/supabase";
import { pushToSheet } from "@/lib/push-to-sheet";
import { recordSheetPushFailure, clearSheetPushFailure } from "@/lib/sheet-push-tracker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;

export interface PushOutcome { ok: boolean; error?: string; skipped?: string }

export async function pushReplyToSheet(replyId: number, opts?: { reply?: Reply; category?: string }): Promise<PushOutcome> {
  let reply = opts?.reply;
  if (!reply) {
    const { data } = await supabase.from("replies").select("*").eq("id", replyId).single();
    reply = data || undefined;
  }
  if (!reply) return { ok: false, skipped: "reply not found" };
  const clientTag = reply.client_tag as string | null;
  if (!clientTag || clientTag === "N/A") return { ok: false, skipped: "no client tag" };

  const category = opts?.category || reply.lead_category || "";

  const result = await pushToSheet(clientTag, {
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
    client_tag: clientTag,
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
    await supabase.from("replies").update({ pushed_to_sheet: true, pushed_to_sheet_at: new Date().toISOString() }).eq("id", replyId);
    await clearSheetPushFailure(replyId);
    return { ok: true };
  }

  // Persist the failure so it surfaces on the dashboard for retry / dismiss.
  await recordSheetPushFailure({
    replyId, clientTag, leadEmail: reply.lead_email || null, leadName: reply.lead_name || null,
    category, error: result.error || "unknown error",
  });
  return { ok: false, error: result.error };
}
