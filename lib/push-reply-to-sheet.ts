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
import { resolveLeadPhones, phonesForSheet } from "@/lib/processing/resolve-phones";
import { loadClientContactEmails } from "@/lib/processing/cc-bcc-match";
import { getReplySheetOverride } from "@/lib/sheet-override";

// Split a raw address cell ("a@x.com, b@y.com; c@z.com") into lowercased emails.
function splitEmails(raw: unknown): string[] {
  return String(raw || "")
    .split(/[,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

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

  // Never add the client's OWN people to their lead-tracking sheet. If any
  // address on the message — sender, recipient(s), CC or BCC — is one of the
  // client's approved ReplyRouter template contacts (their configured CC/BCC
  // emails), this is the client's team on the thread (an internal forward or
  // their own reply), not a prospect. Exclude the message from the sheet.
  const clientContacts = await loadClientContactEmails(clientTag);
  if (clientContacts.size) {
    const participants = [
      ...splitEmails(reply.from_email),
      ...splitEmails(reply.lead_email),
      ...splitEmails(reply.to_email),
      ...splitEmails(reply.prospect_cc_email),
      ...splitEmails(reply.bcc_email),
    ];
    const hit = participants.find((e) => clientContacts.has(e));
    if (hit) return { ok: false, skipped: `client contact on thread (${hit})` };
  }

  const category = opts?.category || reply.lead_category || "";

  // Phone: waterfall — the lead's reply/signature first, then their website
  // (scraped from the email domain), then the Bison company-phone custom var.
  // All numbers from the winning source go in, comma-separated. Best-effort:
  // any failure inside resolveLeadPhones degrades to the custom-var phone.
  let phoneCell = reply.phone || "";
  try {
    const { phones } = await resolveLeadPhones({
      replyBody: reply.reply_we_got || "",
      replySubject: reply.email_subject || "",
      leadEmail: reply.lead_email || "",
      customVarPhone: reply.phone || "",
    });
    if (phones.length) phoneCell = phonesForSheet(phones);
  } catch { /* keep the custom-var phone */ }

  // Per-lead sheet override (set from the inbox) takes precedence over the
  // client-tag → sheet registry for THIS lead only.
  const sheetOverride = await getReplySheetOverride(replyId);

  const result = await pushToSheet(clientTag, {
    lead_email: reply.lead_email || "",
    lead_name: reply.lead_name || "",
    company_name: reply.company_name || "",
    reply_time: reply.reply_time || "",
    city: reply.city || "",
    state: reply.state || "",
    address: reply.address || "",
    google_maps_url: reply.google_maps_url || "",
    phone: phoneCell,
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
  }, sheetOverride ? { spreadsheetId: sheetOverride.spreadsheetId, tabName: sheetOverride.tabName } : null);

  if (result.ok) {
    await supabase.from("replies").update({ pushed_to_sheet: true, pushed_to_sheet_at: new Date().toISOString() }).eq("id", replyId);
    // Persist the EXACT appended row so send-reply can update this lead's
    // "Lead handoff email" cell precisely (Option B). Separate best-effort write
    // — these columns may not exist pre-migration; if so we silently fall back
    // to email-matching at send time (Option A).
    if (result.row) {
      try {
        await supabase.from("replies").update({ sheet_row: result.row, sheet_id: result.sheetId }).eq("id", replyId);
      } catch { /* sheet_row/sheet_id columns not migrated yet */ }
    }
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
