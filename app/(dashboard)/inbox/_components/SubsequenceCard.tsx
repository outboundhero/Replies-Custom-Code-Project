"use client";
import { useState } from "react";
import { toast } from "sonner";

/** Mirror of the server's subsequencePublicView (lib/dm4pm/inbox-actions.ts). */
export interface SubsequenceState {
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

const STATUS_LABEL: Record<string, string> = {
  active: "Active", paused: "Paused", snoozed: "Snoozed", stopped: "Stopped", completed: "Completed",
};

async function callMutate(body: Record<string, unknown>) {
  const res = await fetch("/api/inbox/mutate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return res.json();
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " PT";
  } catch { return iso; }
}

/**
 * "Add to Subsequence" card (§4/§5/§6/§14/§15/§19). Enrollment form when not
 * enrolled; status + Pause/Resume/Stop/Snooze/DNC controls when enrolled.
 * Self-contained — posts to /api/inbox/mutate and calls onChanged() to refresh.
 */
export function SubsequenceCard({ replyId, suggestedFirstName, initial, onChanged }: {
  replyId: number;
  suggestedFirstName: string;
  initial: SubsequenceState | null;
  onChanged: () => void;
}) {
  const [sub, setSub] = useState<SubsequenceState | null>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [firstName, setFirstName] = useState(suggestedFirstName && suggestedFirstName !== "there" ? suggestedFirstName : "");
  const [noName, setNoName] = useState(false);
  const [phone, setPhone] = useState("");
  const [dnc, setDnc] = useState(false);
  const [snoozeDate, setSnoozeDate] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);

  async function run(action: string, extra: Record<string, unknown>, okMsg: string) {
    setBusy(action);
    const d = await callMutate({ action, id: replyId, ...extra });
    setBusy(null);
    if (d?.ok) {
      setSub((d.subsequence as SubsequenceState) ?? null);
      setConfirmStop(false);
      toast.success(okMsg);
      onChanged();
    } else {
      toast.error(d?.error || "Something went wrong");
    }
  }

  const live = sub && ["active", "paused", "snoozed"].includes(sub.status);

  // ── Not (currently) enrolled → enrollment form ─────────────────────────────
  if (!live) {
    const wasTerminal = sub && ["stopped", "completed"].includes(sub.status);
    return (
      <div className="rounded border bg-white px-4 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">DM4PM Follow-up Subsequence</span>
          {wasTerminal && <span className="text-[10px] text-muted-foreground">Previously {STATUS_LABEL[sub!.status]}</span>}
        </div>
        <p className="text-[11px] text-muted-foreground">Automatic 7-step follow-up that pauses the moment they reply or book. Confirm the name and phone before enrolling.</p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-muted-foreground">First name</label>
            <input
              value={noName ? "" : firstName} disabled={noName}
              onChange={(e) => setFirstName(e.target.value)} placeholder="First name"
              className="w-full rounded border px-2 py-1 text-[13px] disabled:bg-muted/30"
            />
            <label className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
              <input type="checkbox" checked={noName} onChange={(e) => setNoName(e.target.checked)} /> No first name (greet &quot;Hi,&quot;)
            </label>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Phone (confirmed only)</label>
            <input
              value={dnc ? "" : phone} disabled={dnc}
              onChange={(e) => setPhone(e.target.value)} placeholder="(555) 123-4567"
              className="w-full rounded border px-2 py-1 text-[13px] disabled:bg-muted/30"
            />
            <label className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
              <input type="checkbox" checked={dnc} onChange={(e) => setDnc(e.target.checked)} /> Do not call (email only)
            </label>
          </div>
        </div>
        <button
          disabled={busy !== null}
          onClick={() => run("enroll-subsequence", {
            firstName: noName ? "" : firstName.trim(),
            firstNameConfirmed: true,
            phone: dnc ? "" : phone.trim(),
            phoneConfirmed: !dnc && phone.trim().length > 0,
            doNotCall: dnc,
          }, "Enrolled in the follow-up subsequence")}
          className="w-full rounded bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy === "enroll-subsequence" ? "Enrolling…" : "Add to Subsequence"}
        </button>
      </div>
    );
  }

  // ── Enrolled → status + manual controls ────────────────────────────────────
  const s = sub!;
  const nextStep = Math.min(s.step + 1, 7);
  return (
    <div className="rounded border bg-white px-4 py-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">DM4PM Subsequence</span>
        <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${
          s.status === "active" ? "border-blue-200 bg-blue-50 text-blue-700"
          : s.status === "paused" ? "border-amber-200 bg-amber-50 text-amber-800"
          : "border-slate-200 bg-slate-50 text-slate-600"}`}>
          {STATUS_LABEL[s.status]} · Step {s.step}/7
        </span>
      </div>
      <div className="text-[11px] text-muted-foreground space-y-0.5">
        {s.status === "active" && <div>Next step (#{nextStep}) scheduled: <b>{fmtDate(s.nextStepDueAt)}</b></div>}
        {s.status === "paused" && (
          <div>
            Paused{s.pausedReason ? ` — ${s.pausedReason.replace(/_/g, " ")}` : ""}.{" "}
            {s.pausedReason === "prospect_reply" && "Reply, then it resumes after 5 business days of silence."}
            {s.pausedReason === "canceled_meeting" && "Meeting canceled — back in Open Responses; Resume to continue."}
            {s.pausedReason === "meeting_booked" && "Meeting booked — waiting on the outcome."}
          </div>
        )}
        {s.status === "snoozed" && <div>Snoozed until <b>{fmtDate(s.snoozeUntil)}</b></div>}
        {s.meetingState !== "none" && <div>Meeting: <b>{s.meetingState.replace(/_/g, " ")}</b></div>}
        {s.doNotCall && <div className="text-amber-700">Do-not-call — phone removed from every step.</div>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {s.status === "active" && <button disabled={busy !== null} onClick={() => run("pause-subsequence", {}, "Paused")} className="rounded border px-2 py-1 text-[12px] hover:bg-muted/40 disabled:opacity-50">Pause</button>}
        {(s.status === "paused" || s.status === "snoozed") && <button disabled={busy !== null} onClick={() => run("resume-subsequence", {}, "Resumed")} className="rounded border px-2 py-1 text-[12px] hover:bg-muted/40 disabled:opacity-50">Resume</button>}
        {!s.doNotCall && <button disabled={busy !== null} onClick={() => run("set-do-not-call", { doNotCall: true }, "Marked do-not-call")} className="rounded border px-2 py-1 text-[12px] hover:bg-muted/40 disabled:opacity-50">Do not call</button>}
        {confirmStop
          ? <button disabled={busy !== null} onClick={() => run("stop-subsequence", {}, "Subsequence stopped")} className="rounded border border-destructive/40 bg-destructive/5 px-2 py-1 text-[12px] font-medium text-destructive disabled:opacity-50">Confirm stop</button>
          : <button onClick={() => setConfirmStop(true)} className="rounded border px-2 py-1 text-[12px] hover:bg-muted/40">Stop</button>}
      </div>
      <div className="flex items-center gap-1.5 pt-0.5">
        <input type="date" value={snoozeDate} onChange={(e) => setSnoozeDate(e.target.value)} className="rounded border px-2 py-1 text-[12px]" />
        <button disabled={busy !== null} onClick={() => run("snooze-subsequence", { snoozeUntil: snoozeDate || undefined }, "Snoozed")} className="rounded border px-2 py-1 text-[12px] hover:bg-muted/40 disabled:opacity-50">
          Snooze{snoozeDate ? "" : " 45d"}
        </button>
      </div>
    </div>
  );
}
