/**
 * DM4PM subsequence engine — drives the step-sender + meeting-sync crons.
 *
 * Per due step it runs the §26 pre-send safety check (business day, no meeting,
 * duplicate guard, DNC, healthy sender), sends in-thread via `sendReply`, and on
 * a dead sender fails over to a healthy same-campaign sender in a new thread
 * (§20). Meeting outcomes (§16/§17/§18) pause/stop/route the subsequence.
 *
 * Opt-out (§22) is enforced upstream: it STOPS the subsequence, so opted-out
 * rows never reach here (only status='active' rows are drained).
 */
import * as store from "@/lib/dm4pm/subsequence-store";
import type { SubsequenceRow } from "@/lib/dm4pm/subsequence-store";
import { checkMeeting, meetingOutcome, type MeetingOutcome } from "@/lib/dm4pm/meeting-tracker";
import { renderStep, DM4PM_STEP_COUNT } from "@/lib/dm4pm/subsequence-templates";
import { scheduleFrom, STEP_CADENCE, isBusinessDay, nextBusinessDay, ctaDays } from "@/lib/business-days";
import { getSenderHealth, pickHealthySender, senderFirstName } from "@/lib/dm4pm/sender-failover";
import { enrollDm4pmInNurture } from "@/lib/dm4pm/nurture-enroll";
import { returnReplyToOpenResponse } from "@/lib/dm4pm/reply-sync";
import { sendReply, sendOneOffReply } from "@/lib/outboundhero-api";
import { reconnectInbox, isReconnectableSendError } from "@/lib/inboxing-upload";
import { coerceInstance } from "@/lib/bison-instances";
import { logError, logActivity } from "@/lib/errors";

/** Bison error is "${status}: ${body}"; some statuses never recover on retry. */
function isPermanentSendError(error?: string): boolean {
  if (!error) return false;
  const status = parseInt(error.split(":")[0]?.trim() || "", 10);
  if (Number.isNaN(status)) return false;
  return [400, 401, 403, 404, 410, 422].includes(status);
}

/** Subject for a failover NEW thread — carry the original so it reads as a reply. */
function failoverSubject(orig: string | null): string {
  const s = (orig || "").trim();
  if (!s) return "Following up";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

// ── Meeting gate (§16/§17/§18) ───────────────────────────────────────────────

/**
 * Evaluate the meeting tracker for a lead and apply the outcome. Returns
 * `handled: true` when the subsequence was paused/stopped/rerouted (so the step
 * cron skips sending). Idempotent — safe to run repeatedly (reconcile cron).
 */
export async function applyMeetingOutcome(row: SubsequenceRow): Promise<{ handled: boolean; outcome: MeetingOutcome }> {
  const email = row.lead_email || "";
  if (!email) return { handled: false, outcome: "none" };
  const outcome = meetingOutcome(await checkMeeting(email));

  switch (outcome) {
    case "none":
      return { handled: false, outcome };

    case "booked_pending":
    case "reschedule": // stay paused, wait for the (re)scheduled meeting's result
      if (row.meeting_state !== "booked") await store.setMeetingState(row.id, "booked");
      if (row.status === "active") await store.pause(row.id, "meeting_booked");
      return { handled: true, outcome };

    case "attended": // §17 — showed / held / existing client → stop, don't resume
      await store.setMeetingState(row.id, "attended");
      await store.stop(row.id);
      return { handled: true, outcome };

    case "qualified_no_show": // §17 — Qualified + No-Show → Re-Contact Queue
      await store.setMeetingState(row.id, "no_show");
      await store.addToRecontactQueue({ replyRowId: row.reply_row_id, clientTag: row.client_tag, leadEmail: email, reason: "qualified_no_show" });
      await store.stop(row.id);
      return { handled: true, outcome };

    case "no_show_drop": // §17 — not qualified no-show → drop, no re-contact
      await store.setMeetingState(row.id, "no_show");
      await store.stop(row.id);
      return { handled: true, outcome };

    case "not_interested": // passed / not interested / franchise → stop → nurture
      await store.stop(row.id);
      await enrollDm4pmInNurture(email);
      return { handled: true, outcome };

    case "duplicate":
      await store.stop(row.id);
      return { handled: true, outcome };

    case "canceled": // §18 — preserve step, return to Open Responses, flag, wait
      if (row.meeting_state !== "canceled") {
        await store.setMeetingState(row.id, "canceled");
        await store.pause(row.id, "canceled_meeting");
        await returnReplyToOpenResponse(row.reply_row_id);
      }
      return { handled: true, outcome };
  }
}

// ── Sending (with failover) ──────────────────────────────────────────────────

interface SendResult { ok: boolean; error?: string; senderEmailId: number | null; bisonReplyId: number | null }

async function sendStep(row: SubsequenceRow, targetStep: number): Promise<SendResult> {
  const instance = coerceInstance(row.bison_instance);
  const toEmail = row.lead_email || "";
  const toName = row.to_name || "";
  const cta = ctaDays(new Date());
  const render = (name: string) =>
    renderStep(targetStep, {
      firstName: row.first_name || "",
      phone: row.phone || "",
      senderName: senderFirstName(name),
      day1: cta.day1,
      day2: cta.day2,
      doNotCall: row.do_not_call === 1,
    });

  const senderEmailId = row.sender_email_id;
  let senderName = row.sender_name || "";
  const threadId = row.active_reply_id ?? row.reply_id ?? null;
  let lastError: string | undefined;

  // 1. In-thread send with the current sender, if healthy.
  if (senderEmailId && threadId) {
    const health = await getSenderHealth(instance, senderEmailId);
    if (health?.name) senderName = health.name; // keep {SENDER_NAME} accurate (§26)
    if (health?.healthy) {
      const r = await sendReply(instance, { replyId: threadId, senderEmailId, message: render(senderName), toEmail, toName });
      if (r.ok) return { ok: true, senderEmailId, bisonReplyId: threadId };
      lastError = r.error;
      // Fail over only on a sender-auth error; other errors are reported as-is.
      if (!isReconnectableSendError(r.error)) return { ok: false, error: r.error, senderEmailId, bisonReplyId: threadId };
    }
  }

  // 2. Failover (§20): reconnect the dead inbox (best-effort) + reassign to a
  //    healthy same-campaign sender, then send a NEW thread (a reassigned
  //    sender can't continue the original thread — confirmed vs Bison API).
  if (row.sender_email) reconnectInbox(row.sender_email, instance).catch(() => {});
  const pick = await pickHealthySender(instance, row.campaign_id, senderEmailId);
  if (!pick) return { ok: false, error: lastError || "no healthy sender available", senderEmailId, bisonReplyId: null };
  await store.reassignSender(row.id, { senderEmailId: pick.id, senderEmail: pick.email, senderName: pick.name });
  const r2 = await sendOneOffReply(instance, {
    senderEmailId: pick.id,
    subject: failoverSubject(row.subject),
    message: render(pick.name),
    toEmail,
    toName,
  });
  if (r2.ok) {
    if (r2.replyId) await store.setActiveThread(row.id, r2.replyId); // thread later steps here
    return { ok: true, senderEmailId: pick.id, bisonReplyId: r2.replyId ?? null };
  }
  return { ok: false, error: r2.error, senderEmailId: pick.id, bisonReplyId: null };
}

// ── Step processing ──────────────────────────────────────────────────────────

async function scheduleNext(id: number, sentStep: number): Promise<void> {
  if (sentStep >= DM4PM_STEP_COUNT) return completeAndNurture(id);
  const nextDue = scheduleFrom(new Date(), STEP_CADENCE[sentStep]).toISOString();
  await store.advanceStep(id, sentStep, nextDue);
}

async function completeAndNurture(id: number): Promise<void> {
  await store.advanceStep(id, DM4PM_STEP_COUNT, null);
  await store.markCompleted(id);
  const row = await store.getById(id);
  if (row?.lead_email) await enrollDm4pmInNurture(row.lead_email); // §23 → nurture soft-no
}

export type ProcessResult = { status: "sent" | "handled" | "skipped" | "retry" | "failed" | "completed"; reason?: string };

export async function processDueStep(row: SubsequenceRow): Promise<ProcessResult> {
  const targetStep = row.step + 1;
  if (targetStep > DM4PM_STEP_COUNT) {
    await completeAndNurture(row.id);
    return { status: "completed" };
  }
  // §26: only send on a valid business day (guards cron catch-up on weekends).
  if (!isBusinessDay(new Date())) {
    await store.advanceStep(row.id, row.step, nextBusinessDay(new Date()).toISOString());
    return { status: "skipped", reason: "non-business-day" };
  }
  // §26: no duplicate send — recover a crash between send and advance.
  if (await store.hasSentStep(row.id, targetStep)) {
    await scheduleNext(row.id, targetStep);
    return { status: "skipped", reason: "already-sent" };
  }
  // §16/§26: meeting gate — pause/stop/route if a meeting exists.
  const meeting = await applyMeetingOutcome(row);
  if (meeting.handled) return { status: "handled", reason: `meeting:${meeting.outcome}` };

  const send = await sendStep(row, targetStep);
  await store.recordSend(row.id, targetStep, {
    senderEmailId: send.senderEmailId,
    bisonReplyId: send.bisonReplyId,
    status: send.ok ? "sent" : "failed",
    error: send.error ?? null,
  });

  if (send.ok) {
    await logActivity("dm4pm-subsequence", "step-sent", {
      lead_email: row.lead_email || undefined,
      details: { step: targetStep, subsequence_id: row.id, new_thread: send.bisonReplyId !== (row.active_reply_id ?? row.reply_id) },
    });
    await scheduleNext(row.id, targetStep);
    return { status: "sent" };
  }

  const permanent = isPermanentSendError(send.error);
  await logError("dm4pm-subsequence", "step-send", send.error || "send failed", {
    subsequence_id: row.id, step: targetStep, reply_row_id: row.reply_row_id, permanent,
  });
  if (permanent) {
    // Malformed/invalid/gone — don't loop; pause for manual attention.
    await store.pause(row.id, "sender_failed");
    return { status: "failed", reason: `permanent:${send.error}` };
  }
  // Transient (429/5xx/network/no-healthy-sender) → retry the SAME step in ~1h.
  await store.advanceStep(row.id, row.step, new Date(Date.now() + 3_600_000).toISOString());
  return { status: "retry", reason: send.error };
}

// ── Cron entry points ────────────────────────────────────────────────────────

export interface StepCronResult {
  woke: number; processed: number; sent: number; handled: number; skipped: number; retry: number; failed: number;
}

/** Step-sender cron: wake snoozes, drain due steps + continuation timers (§12). */
export async function runStepCron(): Promise<StepCronResult> {
  const woke = await store.wakeDueSnoozed();
  const active = await store.getDueActive(50);
  const continuation = await store.getDueContinuation(50);
  // Continuation rows fire the next unsent step immediately (no +2d delay).
  for (const row of continuation) await store.activateForContinuation(row.id);

  const counts: StepCronResult = { woke, processed: 0, sent: 0, handled: 0, skipped: 0, retry: 0, failed: 0 };
  const seen = new Set<number>();
  for (const base of [...active, ...continuation]) {
    if (seen.has(base.id)) continue;
    seen.add(base.id);
    const fresh = await store.getById(base.id);
    if (!fresh || fresh.status !== "active") continue; // recheck: a concurrent reconcile may have stopped it
    counts.processed++;
    const res = await processDueStep(fresh);
    if (res.status === "sent") counts.sent++;
    else if (res.status === "handled") counts.handled++;
    else if (res.status === "skipped") counts.skipped++;
    else if (res.status === "retry") counts.retry++;
    else if (res.status === "failed") counts.failed++;
  }
  return counts;
}

/** Meeting-sync reconcile cron: apply meeting outcomes to all live enrollments. */
export async function runMeetingSyncCron(): Promise<{ scanned: number; changed: number; outcomes: Record<string, number> }> {
  const rows = await store.getLiveEnrollments(1000);
  const outcomes: Record<string, number> = {};
  let changed = 0;
  for (const row of rows) {
    const { handled, outcome } = await applyMeetingOutcome(row);
    outcomes[outcome] = (outcomes[outcome] || 0) + 1;
    if (handled) changed++;
  }
  return { scanned: rows.length, changed, outcomes };
}
