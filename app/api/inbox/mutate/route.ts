import { NextRequest, NextResponse, after } from "next/server";
import { getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { sendReply, forwardReply, sendOneOffReply, getFirstSentEmail } from "@/lib/outboundhero-api";
import { blacklistDomain, blacklistEmail, isPersonalDomain, extractDomain } from "@/lib/processing/domain-blacklist";
import { SHEET_PUSH_CATEGORIES, leadEmailInSheet } from "@/lib/push-to-sheet";
import { pushReplyToSheet } from "@/lib/push-reply-to-sheet";
import { setLeadHandoffEmail } from "@/lib/sheet-handoff";
import { htmlToText, textToHtml } from "@/lib/html-text";
import { pushToGhl, isGhlPushCategory } from "@/lib/push-to-ghl";
import { extractRedirectEmails, type RedirectCandidate } from "@/lib/processing/extract-redirect-email";
import { regenerateReply } from "@/lib/processing/regenerate-reply";
import { generatePrimaryContactReply } from "@/lib/processing/primary-contact-reply";
import { extractReturnDate } from "@/lib/processing/extract-return-date";
import { logActivity, logError } from "@/lib/errors";
import { coerceInstance, DEFAULT_INSTANCE } from "@/lib/bison-instances";
import { bumpCacheVersion } from "@/lib/inbox-cache";
import { applyReallocate } from "@/lib/processing/apply-reallocate";
import { syncReplyStatusToBison } from "@/lib/bison-reply-status";

// Category change + send-reply now do extra best-effort work (phone waterfall:
// reply AI + optional website scrape for the sheet; the handoff-email sheet
// write on send). Give the route ample headroom over the platform default so a
// slow website fetch can never time the request out.
export const maxDuration = 60;

// Default OOO requeue delay when the reply gives no clear return date (§21).
const DEFAULT_OOO_DELAY_DAYS = 7;

export async function POST(req: NextRequest) {
  // Single session read (was requireAuth() + a second getSession() below).
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { action, id } = body;

    // Per-user client scoping + per-row instance lookup. Both rely on the
    // same row, so fetch once. `rowInstance` is the Bison instance every
    // outgoing API call in this handler should target — it's the only
    // instance this row's IDs (sender_id, reply_id, campaign_id) are
    // valid on.
    let rowInstance: string = DEFAULT_INSTANCE;
    let rowReplyId: number | null = null;
    let rowClientTag: string | null = null;
    let rowLeadCategory: string | null = null;
    let rowCreatedAt: string | null = null;
    let rowSubject: string | null = null;
    if (id) {
      const allowed = session?.allowedClientTags ?? null;
      const { data: row } = await supabase
        .from("replies")
        .select("client_tag, bison_instance, reply_id, lead_category, created_at, email_subject")
        .eq("id", id)
        .single();
      if (allowed && allowed.length) {
        if (!row || !row.client_tag || !allowed.includes(row.client_tag)) {
          return NextResponse.json({ error: "Not found" }, { status: 404 });
        }
      }
      rowInstance = coerceInstance(row?.bison_instance);
      rowReplyId = (row?.reply_id as number | null) ?? null;
      rowClientTag = (row?.client_tag as string | null) ?? null;
      rowLeadCategory = (row?.lead_category as string | null) ?? null;
      rowCreatedAt = (row?.created_at as string | null) ?? null;
      rowSubject = (row?.email_subject as string | null) ?? null;
    }

    switch (action) {
      case "update-category": {
        const { category } = body;
        const nowIso = new Date().toISOString();
        const { error } = await supabase
          .from("replies")
          .update({ lead_category: category, updated_at: nowIso })
          .eq("id", id);
        if (error) throw new Error(error.message);
        // Counts cache stale now — category moved between buckets.
        bumpCacheVersion();

        // ── Speed-to-Lead timing (best-effort; columns may not exist until the
        // sql/2026-07_speed_to_lead.sql migration is run, so a failure here must
        // never break categorization). "Open Response" == null/that label.
        const oldCat = rowLeadCategory || "Open Response";
        const newCat = String(category || "Open Response");
        if (oldCat !== newCat) {
          const timing: Record<string, unknown> = {};
          if (newCat === "Open Response") {
            // Restored to Open Response → restart the clock.
            timing.open_response_at = nowIso;
            timing.categorized_at = null;
            timing.time_to_categorize_seconds = null;
            timing.categorized_by = null;
          } else {
            // Categorized out of Open Response (first time or re-categorized).
            timing.categorized_at = nowIso;
            timing.categorized_by = session.email;
            if (oldCat === "Open Response") {
              // Stamp the final Open-Response duration ONCE, on first exit.
              // Fetch open_response_at separately so a missing column (pre-
              // migration) can't fail the row lookup above.
              let startIso = rowCreatedAt;
              const { data: orRow } = await supabase
                .from("replies").select("open_response_at").eq("id", id).single();
              if (orRow && (orRow as { open_response_at?: string }).open_response_at) {
                startIso = (orRow as { open_response_at?: string }).open_response_at!;
              }
              if (startIso) {
                const secs = Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(startIso)) / 1000));
                if (Number.isFinite(secs)) timing.time_to_categorize_seconds = secs;
              }
            }
          }
          const { error: tErr } = await supabase.from("replies").update(timing).eq("id", id);
          if (tErr) console.warn("[inbox/update-category] timing update skipped:", tErr.message);

          // Moving OFF a category that schedules a delayed auto-reply (e.g.
          // declining a Not-Interested Send-Reply preview → Open Response, or
          // re-triaging) cancels the pending send so it never fires.
          const schedules = (c: string) => c === "Not Interested (Send Reply)" || c === "Out Of Office";
          if (schedules(oldCat) && !schedules(newCat)) {
            const { error: cErr } = await supabase
              .from("replies")
              .update({ auto_reply_due_at: null })
              .eq("id", id);
            if (cErr) console.warn("[inbox/update-category] auto-reply cancel skipped:", cErr.message);
          }
        }

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

        // Change Of Target does NOT auto-send anymore — the inbox opens a
        // preview (prepare-change-of-target) so the user picks the destination
        // and approves before anything goes out (spec §22).

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

        // Out Of Office → AI extracts the return date from the reply, then the
        // auto-reply cron re-sends the original first cold email on the next
        // eligible send date. Per spec §21 that is the day AFTER the stated
        // return date ("out until Jul 28" → send Jul 29), so we never email
        // before the person is back. When no date can be found we DON'T skip —
        // we requeue after a default delay so the lead is never dropped.
        if (category === "Out Of Office") {
          const { data: ooReply } = await supabase
            .from("replies")
            .select("reply_we_got")
            .eq("id", id)
            .single();
          const replyText = (ooReply?.reply_we_got as string | null) || "";
          const returnDate = await extractReturnDate(replyText);

          // Compute the next eligible send date, fired at 09:00 PT (16:00 UTC).
          const target = returnDate ? new Date(`${returnDate}T16:00:00Z`) : new Date();
          target.setUTCDate(target.getUTCDate() + (returnDate ? 1 : DEFAULT_OOO_DELAY_DAYS));
          target.setUTCHours(16, 0, 0, 0);
          const dueAt = target.toISOString();

          const { error: schedErr } = await supabase
            .from("replies")
            .update({ auto_reply_due_at: dueAt, auto_reply_kind: "out_of_office", auto_reply_sent_at: null })
            .eq("id", id);
          if (schedErr) extras.auto_reply_schedule_error = schedErr.message;
          else {
            extras.auto_reply_due_at = dueAt;
            extras.out_of_office_return_date = returnDate || null;
            if (!returnDate) extras.out_of_office_default_delay_days = DEFAULT_OOO_DELAY_DAYS;
          }
        }

        // Auto-push to the client's lead-tracking sheet for positive categories.
        // A failure is recorded durably (Sheet Pushes dashboard) so no lead is
        // ever silently lost — retried until it succeeds or is dismissed.
        if (SHEET_PUSH_CATEGORIES.some((c) => c.toLowerCase() === category?.toLowerCase())) {
          const result = await pushReplyToSheet(id, { category });
          if (!result.skipped) {
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

        // Mirror the mark to the ORIGINATING Bison instance:
        //   Interested / Meeting-Ready Lead / Follow Up → mark-as-interested
        //   Do Not Contact                              → unsubscribe
        // Best-effort — a Bison hiccup never blocks the category change.
        const bisonSync = await syncReplyStatusToBison({
          instance: rowInstance,
          replyId: rowReplyId,
          category,
          source: "inbox",
          clientTag: rowClientTag,
        });
        if (bisonSync.action) {
          extras.bison_action = bisonSync.action;
          if (!bisonSync.ok) extras.bison_error = bisonSync.error;
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
        // Add the lead to the NEW client's tracking sheet so a reallocated lead
        // shows up under the new client — but only when it's in a sheet-push
        // category, and only if it isn't already there (dedup, so reallocating
        // back and forth never doubles a row). Runs after the response so the
        // button stays snappy; best-effort — never fails the reallocate.
        if (rowLeadCategory && SHEET_PUSH_CATEGORIES.some((c) => c.toLowerCase() === rowLeadCategory!.toLowerCase())) {
          after(async () => {
            try {
              const { data: r } = await supabase.from("replies").select("lead_email").eq("id", id).single();
              const email = String(r?.lead_email || "");
              if (await leadEmailInSheet(client_tag, email)) return; // already in the new sheet
              await pushReplyToSheet(id, { category: rowLeadCategory! });
            } catch { /* best-effort */ }
          });
        }
        return NextResponse.json({ ok: true });
      }

      case "sync-template": {
        // Re-pull the CURRENT client's latest reply template + CC/BCC into this
        // reply and re-map the variables — for leads that were sitting in the
        // inbox before their client's template/config was set. Reuses the same
        // path as reallocate (same tag → no move, just refresh the fields).
        if (!rowClientTag || rowClientTag === "N/A") {
          return NextResponse.json({ ok: false, error: "This lead has no client tag to sync a template from." }, { status: 400 });
        }
        const result = await applyReallocate(id, rowClientTag);
        if (!result.ok) throw new Error(result.error);
        return NextResponse.json({ ok: true, client_tag: rowClientTag });
      }

      case "send-reply": {
        const { replyId, senderEmailId, message, toEmail, toName, ccEmails, bccEmails, clearAutoReply } = body;
        const result = await sendReply(rowInstance, { replyId, senderEmailId, message, toEmail, toName, ccEmails, bccEmails, subject: rowSubject ?? undefined });
        const nowIso = new Date().toISOString();
        // History row (success OR failure) so the inbox can show the full
        // outbound history + retry failures. Best-effort — never break the send.
        const recordSend = async (status: "sent" | "failed", error?: string) => {
          try {
            await supabase.from("reply_sends").insert({
              reply_row_id: id, client_tag: rowClientTag, lead_email: toEmail || null,
              message: message ?? null, to_json: toEmail ? [{ name: toName || "", email: toEmail }] : null,
              cc_json: ccEmails ?? null, bcc_json: bccEmails ?? null, status, error: error ?? null,
            });
          } catch { /* table may not exist pre-migration */ }
        };
        if (result.ok) {
          const update: Record<string, unknown> = {
            sent_reply: message, last_sent_at: nowIso, send_error: null, send_error_at: null, updated_at: nowIso,
          };
          // Approving a Send-Reply preview sends NOW — cancel any pending
          // scheduled auto-reply (e.g. the 5–10 min Not-Interested cron) so
          // the lead doesn't also get the delayed one (spec §15).
          if (clearAutoReply) { update.auto_reply_due_at = null; update.auto_reply_sent_at = nowIso; }
          await supabase.from("replies").update(update).eq("id", id);
          // Everything below is bookkeeping/side-effects that the user doesn't
          // need to wait on — run it AFTER the response so Send Reply feels
          // instant. The ~1s Google-Sheet handoff write was the main drag on the
          // critical path. Reliable on Vercel (after() keeps the function alive);
          // both writes are best-effort and never affect the send result.
          after(async () => {
            await recordSend("sent");
            // Record the SENT email into the client's sheet under "Lead handoff
            // email" — only on a real send, never the template/draft. Uses the
            // exact appended row (sheet_row/sheet_id) when known, else email-match.
            if (rowClientTag && rowClientTag !== "N/A" && toEmail) {
              try {
                const { data: sr } = await supabase.from("replies")
                  .select("sheet_row, sheet_id").eq("id", id).single();
                await setLeadHandoffEmail(rowClientTag, toEmail, htmlToText(message || ""), {
                  row: sr?.sheet_row ?? undefined, sheetId: sr?.sheet_id ?? undefined,
                });
              } catch { /* handoff-email sheet write is best-effort */ }
            }
          });
        } else {
          // Persist the failure so it stays visible on the lead + in the error
          // log until the next successful send clears it. Draft is NOT touched.
          await logError("inbox", "send-reply", result.error || "send failed", {
            row_id: id, client_tag: rowClientTag, lead_email: toEmail, instance: rowInstance,
          });
          try {
            await supabase.from("replies").update({ send_error: result.error || "Send failed", send_error_at: nowIso, updated_at: nowIso }).eq("id", id);
          } catch { /* columns may not exist pre-migration */ }
          await recordSend("failed", result.error);
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

      case "update-fields": {
        // Generic whitelisted field editor (Data View record panel). Writes the
        // same replies row the inbox reads, so edits reflect everywhere.
        const EDITABLE = new Set(["lead_name", "lead_email", "first_name", "last_name", "company_name", "phone", "city", "state", "notes"]);
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries((body.fields as Record<string, unknown>) || {})) {
          if (EDITABLE.has(k)) patch[k] = typeof v === "string" ? v.trim() : v;
        }
        if (!Object.keys(patch).length) return NextResponse.json({ ok: false, error: "No editable fields" }, { status: 400 });
        patch.updated_at = new Date().toISOString();
        const { error: ufErr } = await supabase.from("replies").update(patch).eq("id", id);
        if (ufErr) return NextResponse.json({ ok: false, error: ufErr.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      case "primary-contact-reply": {
        // Scenario-aware "Request for Primary Point of Contact" draft (§23):
        // org named in the reply > confident company-data fallback > generic ask.
        const { firstName } = body;
        const { data: reply } = await supabase
          .from("replies")
          .select("reply_we_got, first_name, lead_name, from_name, sender_name, company_name")
          .eq("id", id)
          .single();
        const leadFirst = String(firstName || reply?.first_name || "").trim()
          || String(reply?.lead_name || reply?.from_name || "").trim().split(/\s+/)[0] || "";
        const senderFirst = String(reply?.sender_name || "").trim().split(/\s+/)[0] || "";
        const result = await generatePrimaryContactReply({
          replyBody: (reply?.reply_we_got as string | null) || "",
          firstName: leadFirst,
          senderFirstName: senderFirst,
          companyName: (reply?.company_name as string | null) || "",
        });
        return NextResponse.json(result);
      }

      case "regenerate-reply": {
        // Rewrite the staged reply draft for the Send-Reply preview (spec §15).
        // Reads the lead's inbound message for context; never sends.
        const { currentDraft, instructions, senderName, leadName } = body;
        const { data: reply } = await supabase
          .from("replies")
          .select("reply_we_got")
          .eq("id", id)
          .single();
        const result = await regenerateReply({
          replyBody: (reply?.reply_we_got as string | null) || "",
          currentDraft: currentDraft || "",
          instructions: instructions || "",
          senderName: senderName || "",
          leadName: leadName || "",
        });
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
        const result = await pushReplyToSheet(id);
        if (result.skipped) return NextResponse.json({ error: result.skipped === "no client tag" ? "Cannot push N/A client to sheet" : "Reply not found" }, { status: 400 });
        return NextResponse.json(result);
      }

      case "prepare-change-of-target": {
        const prep = await prepareChangeOfTarget(id, rowInstance);
        return NextResponse.json(prep);
      }

      case "send-change-of-target": {
        const { senderEmailId, toEmail, toName, subject, message } = body;
        if (!toEmail || !senderEmailId || !message) {
          return NextResponse.json({ ok: false, error: "Missing recipient, sender, or message" }, { status: 400 });
        }
        const result = await sendOneOffReply(rowInstance, {
          senderEmailId, subject: subject || "(no subject)", message, toEmail, toName: toName || "",
        });
        if (result.ok) {
          await logActivity("inbox", "change-of-target-sent", {
            client_tag: rowClientTag || undefined,
            details: { reply_id: id, new_email: toEmail, new_name: toName, sender_email_id: senderEmailId, bison_instance: rowInstance },
          });
        } else {
          await logError("inbox", "change-of-target", result.error || "send failed", { reply_id: id, new_email: toEmail });
        }
        return NextResponse.json(result);
      }

      case "archive": {
        const { error } = await supabase
          .from("replies")
          .update({ archived: true, archived_at: new Date().toISOString() })
          .eq("id", id);
        if (error) throw new Error(error.message);
        bumpCacheVersion();
        return NextResponse.json({ ok: true });
      }

      case "restore": {
        // Restore an archived reply to the ACTIVE inbox in Open Response, which
        // restarts the speed-to-lead clock (spec §3).
        const nowIso = new Date().toISOString();
        const { error } = await supabase
          .from("replies")
          .update({
            archived: false, archived_at: null,
            lead_category: "Open Response",
            open_response_at: nowIso, categorized_at: null,
            time_to_categorize_seconds: null, categorized_by: null,
            updated_at: nowIso,
          })
          .eq("id", id);
        if (error) throw new Error(error.message);
        bumpCacheVersion();
        return NextResponse.json({ ok: true });
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

interface ChangeOfTargetPrep {
  ok: boolean;
  reason?: string;
  candidates?: RedirectCandidate[];   // all alternative emails found (first = recommended)
  subject?: string;
  messageTemplate?: string;           // greeting uses {FIRST_NAME} — the client resolves it per recipient
  senderEmailId?: number;
  senderName?: string;
  originalLeadDisplayName?: string;
  manual?: boolean;                   // untracked fallback: generic draft, no original cold email wrapped (§26)
}

/**
 * PREPARE a Change-of-Target re-pitch WITHOUT sending (spec §22): extract every
 * alternative contact from the reply and build the wrapped original cold email
 * for the inbox preview. The user then picks the destination + approves, and
 * the `send-change-of-target` action does the actual send. Never throws.
 */
async function prepareChangeOfTarget(replyId: number, instanceKey: string): Promise<ChangeOfTargetPrep> {
  try {
    const { data: reply, error } = await supabase
      .from("replies")
      .select("lead_id, lead_email, lead_name, reply_we_got, campaign_id, sender_id, sender_name")
      .eq("id", replyId)
      .single();
    if (error || !reply) return { ok: false, reason: "Reply not found" };

    const leadId = reply.lead_id as number | null;
    const campaignId = (reply.campaign_id as number | null) ?? null;
    const originalLeadEmail = (reply.lead_email as string | null) || "";
    const replyBody = (reply.reply_we_got as string | null) || "";

    if (!replyBody.trim()) return { ok: false, reason: "Reply body is empty — nothing to extract from." };

    // Extract ALL alternative contacts for the picker.
    const candidates = await extractRedirectEmails(replyBody, originalLeadEmail);
    const originalLeadDisplayName =
      ((reply.lead_name as string | null) || "").trim() || originalLeadEmail || "the lead we contacted";

    // Preferred path: wrap the ORIGINAL cold email from the same campaign so the
    // new contact sees exactly what we pitched. Needs a tracked lead + campaign.
    if (leadId && campaignId) {
      const firstEmail = await getFirstSentEmail(instanceKey, leadId, campaignId);
      if (firstEmail?.sender_email?.id) {
        const senderName = (firstEmail.sender_email.name || "").trim() || "the team";
        // Re-pitch: greet the new contact, then quote the FULL original cold email
        // we sent the redirecting contact. Built as plain text (blank lines between
        // paragraphs + surrounding double-quotes) so the editor and the sent email
        // both read cleanly. {FIRST_NAME} is resolved per-recipient in the UI.
        // Normal hyphen, not an em dash.
        const originalText = htmlToText(firstEmail.email_body || "").trim();
        const messageText = (
          `Hi {FIRST_NAME},\n\n` +
          `We received your email from ${originalLeadDisplayName} - here's the email we sent them. Let me know if you're interested.\n\n` +
          `"${originalText}"`
        ).replace(/\s*—\s*/g, " - "); // never let an em dash reach the recipient
        const messageTemplate = textToHtml(messageText);
        const origSubject = (firstEmail.email_subject || "").trim();
        return {
          ok: true, candidates,
          subject: `Received your contact info from ${originalLeadDisplayName}'s automated email${origSubject ? ` - ${origSubject}` : ""}`,
          messageTemplate, senderEmailId: firstEmail.sender_email.id,
          senderName, originalLeadDisplayName,
        };
      }
    }

    // Fallback for untracked replies / no original email found (spec §26): still
    // let the user re-pitch the new contact with an editable generic draft, sent
    // from the account that received this reply. No original cold email to wrap.
    const senderId = (reply.sender_id as number | null) ?? null;
    if (!senderId) {
      return { ok: false, reason: "This reply isn't linked to a lead or a sending account, so it can't be re-pitched. Use a One-Off Reply instead.", candidates };
    }
    const senderName = ((reply.sender_name as string | null) || "").trim() || "the team";
    const messageTemplate =
      `<p>Hi {FIRST_NAME},</p>` +
      `<p>${escapeHtml(originalLeadDisplayName)} passed your details along to me. I'd love to share how we can help - would you be open to a quick chat?</p>` +
      `<p>Best,</p>` +
      `<p>${escapeHtml(senderName)}</p>`;
    return {
      ok: true, candidates,
      subject: "Following up", messageTemplate,
      senderEmailId: senderId, senderName, originalLeadDisplayName,
      manual: true,
    };
  } catch (e) {
    await logError("inbox", "change-of-target-prepare", (e as Error).message || "unknown", { reply_id: replyId });
    return { ok: false, reason: (e as Error).message || "unknown error" };
  }
}
