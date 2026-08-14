/**
 * Inbox mutate actions for the DM4PM subsequence (§4/§14/§15/§16/§19).
 * Delegated from app/api/inbox/mutate/route.ts. All actions are DM4PM-only
 * (§27) and operate through the subsequence store.
 */
import supabase from "@/lib/supabase";
import * as store from "@/lib/dm4pm/subsequence-store";
import type { SubsequenceRow } from "@/lib/dm4pm/subsequence-store";
import { coerceInstance } from "@/lib/bison-instances";
import { isSubsequenceTag } from "@/lib/subsequence/config";

export interface SubsequenceCtx {
  clientTag: string | null;
}

export interface ActionResult {
  data?: unknown;
  error?: string;
  status?: number;
}

export interface SubsequencePublic {
  enrolled: boolean;
  step: number;
  status: string;
  pausedReason: string | null;
  meetingState: string;
  nextStepDueAt: string | null;
  snoozeUntil: string | null;
  doNotCall: boolean;
  firstName: string | null;
  firstNameConfirmed: boolean;
  phone: string | null;
  phoneConfirmed: boolean;
}

export function subsequencePublicView(s: SubsequenceRow): SubsequencePublic {
  return {
    enrolled: ["active", "paused", "snoozed"].includes(s.status),
    step: s.step,
    status: s.status,
    pausedReason: s.paused_reason,
    meetingState: s.meeting_state,
    nextStepDueAt: s.next_step_due_at,
    snoozeUntil: s.snooze_until,
    doNotCall: s.do_not_call === 1,
    firstName: s.first_name,
    firstNameConfirmed: s.first_name_confirmed === 1,
    phone: s.phone,
    phoneConfirmed: s.phone_confirmed === 1,
  };
}

const DEFAULT_SNOOZE_DAYS = 45; // §14 — vague "later" defaults to 45 days

const b = (v: unknown): boolean => v === true || v === "true";
const s = (v: unknown): string => (v == null ? "" : String(v)).trim();

/** Handle one DM4PM subsequence mutate action. Returns a plain result the route
 *  maps to a NextResponse. Gated to client_tag = "DM4PM" (§27). */
export async function handleDm4pmSubsequenceAction(
  action: string,
  id: number,
  body: Record<string, unknown>,
  ctx: SubsequenceCtx,
): Promise<ActionResult> {
  if (!id) return { error: "id required", status: 400 };
  if (!isSubsequenceTag(ctx.clientTag)) {
    return { error: "The follow-up subsequence is available for DM4PM and OH leads only.", status: 400 };
  }

  if (action === "enroll-subsequence") {
    const { data: row } = await supabase
      .from("replies")
      .select("reply_id, sender_id, sender_name, sender_email, lead_email, lead_name, from_name, from_email, lead_id, campaign_id, bison_instance, email_subject")
      .eq("id", id)
      .single();
    if (!row) return { error: "reply not found", status: 404 };
    const r = row as Record<string, unknown>;
    // Address the person who actually REPLIED (from_email/from_name), falling
    // back to the lead record. For DM4PM the lead record is often a generic
    // cold-campaign target, not the real respondent.
    const leadEmail = s(r.from_email) || s(r.lead_email);
    if (!leadEmail) return { error: "This reply has no lead email to send to.", status: 400 };
    const toName = s(r.from_name) || s(r.lead_name) || null;

    const firstName = s(body.firstName);
    const phone = s(body.phone);
    const enrolled = await store.enroll({
      replyRowId: id,
      clientTag: ctx.clientTag,
      bisonInstance: coerceInstance(r.bison_instance as string | null),
      replyId: (r.reply_id as number | null) ?? null,
      leadId: (r.lead_id as number | null) ?? null,
      leadEmail,
      campaignId: (r.campaign_id as number | null) ?? null,
      senderEmailId: (r.sender_id as number | null) ?? null,
      senderEmail: (r.sender_email as string | null) ?? null,
      senderName: (r.sender_name as string | null) ?? null,
      toName,
      subject: (r.email_subject as string | null) ?? null,
      firstName,
      firstNameConfirmed: b(body.firstNameConfirmed) || firstName.length > 0,
      phone,
      phoneConfirmed: b(body.phoneConfirmed) && phone.length > 0,
      doNotCall: b(body.doNotCall),
    });
    return { data: { ok: true, subsequence: subsequencePublicView(enrolled) } };
  }

  // Every other action targets an existing enrollment. Resolve by the reply row
  // first, then by the lead's email (a repeat reply the operator is viewing may
  // be a different row than the one enrollment was created on).
  let sub = await store.getByReplyRowId(id);
  if (!sub) {
    const { data: r0 } = await supabase.from("replies").select("lead_email").eq("id", id).single();
    const email = s((r0 as Record<string, unknown> | null)?.lead_email);
    if (email) sub = await store.getByEmail(email);
  }
  if (!sub) return { error: "This lead is not enrolled in the subsequence.", status: 404 };

  switch (action) {
    case "set-subsequence-vars": {
      const firstName = body.firstName !== undefined ? s(body.firstName) : undefined;
      const phone = body.phone !== undefined ? s(body.phone) : undefined;
      await store.updateVars(sub.id, {
        firstName,
        firstNameConfirmed: body.firstNameConfirmed !== undefined ? b(body.firstNameConfirmed) : undefined,
        phone,
        phoneConfirmed: body.phoneConfirmed !== undefined ? b(body.phoneConfirmed) : undefined,
      });
      break;
    }
    case "pause-subsequence":
      await store.pause(sub.id, "manual");
      break;
    case "resume-subsequence":
      await store.resume(sub.id);
      break;
    case "stop-subsequence":
      await store.stop(sub.id);
      break;
    case "snooze-subsequence": {
      const until = s(body.snoozeUntil);
      const untilIso = until
        ? new Date(until).toISOString()
        : new Date(Date.now() + DEFAULT_SNOOZE_DAYS * 24 * 3_600_000).toISOString();
      await store.snooze(sub.id, untilIso);
      break;
    }
    case "subsequence-meeting-booked": // §16 manual "Meeting Booked / Pause"
      await store.setMeetingState(sub.id, "booked");
      await store.pause(sub.id, "meeting_booked");
      break;
    case "set-do-not-call":
      await store.setDoNotCall(sub.id, body.doNotCall !== false);
      break;
    default:
      return { error: `unknown subsequence action "${action}"`, status: 400 };
  }

  const fresh = await store.getByReplyRowId(id);
  return { data: { ok: true, subsequence: fresh ? subsequencePublicView(fresh) : null } };
}
