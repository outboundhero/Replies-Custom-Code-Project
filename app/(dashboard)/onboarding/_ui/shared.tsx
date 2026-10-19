"use client";

/**
 * Onboarding UI shared by the list page and the client page: the data shapes,
 * the mutate helper, and the checklist itself (owner sections → task lines →
 * the Run dialog).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, Circle, FileClock, Loader2, Lock, Minus, Pencil, RefreshCw, X, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  STATUS_META, TASK_STATUS_ORDER, AUTOMATION_META, GROUP_META, fmtDate, fmtStamp, shortEmail, todayStr,
} from "@/lib/onboarding/ui";
import { blockingTask, type TaskStatus } from "@/lib/onboarding/generate";

// ─────────────────────────── types ───────────────────────────
export type OnbClient = {
  client_tag: string; client_name: string | null; plan_type: string | null; group_num: 1 | 2 | null;
  /** The time zone all of this client's campaigns send in (Clay's choices); null until chosen. */
  campaign_timezone?: string | null;
  start_date: string; status: string; tasks_total: number; tasks_done: number;
};
export type LastRun = { at: string; by: string | null; ok: boolean; summary: string };
export type OnbTask = {
  id: string; client_tag: string; template_task_id: string | null; title: string;
  task_group: string | null; day_offset: number; due_date: string | null;
  /** An onboarding user id (legacy column name). */
  assignee_email: string | null;
  status: TaskStatus; order_index: number; due_date_overridden: number;
  /** 1 = ordered step: no due date, runs after the ordered steps before it. */
  no_due: number;
  automation: string | null;
  /** The server's word on whether this step's automation can be RUN right now (its switch is on). */
  runnable?: boolean;
  completed_at: string | null; completed_by: string | null; last_run: LastRun | null;
};
export type UserRow = { id: string; name: string; slack_member_id: string | null; email: string | null };
export type BoardData = {
  clients: OnbClient[]; tasks: OnbTask[]; users: UserRow[];
  outreachifySlack: { saved: string | null; sendsTo: string[] };
  /** Each automation's live state on the server: on / off (switch not set) / preview (sending not built). */
  automationStates: Record<string, "on" | "off" | "preview">;
};

export const UNASSIGNED = "—";

export async function postMutate(body: Record<string, unknown>): Promise<{ ok?: boolean; error?: string; [k: string]: unknown }> {
  const res = await fetch("/api/onboarding/mutate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (res.status === 401) { window.location.href = "/login"; return { error: "unauthorized" }; }
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}

// ─────────────────────────── small bits ───────────────────────────
/**
 * "Waiting for the Onboarding Form" — shown on a client's checklist and guided page until its form is
 * in (a row with the tag in column A and the Onboarding Call date in column D; lib/onboarding/form-gate.ts).
 * Nothing shows once it's in, or when the sheet couldn't be read (the steps say that themselves).
 */
export function FormGateBanner({ tag, onReady }: { tag: string; onReady?: () => void }) {
  const [gate, setGate] = useState<{ state: string; ready: boolean; message: string | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const check = useCallback(async (fresh: boolean) => {
    const r = await fetch(`/api/onboarding/form-status?tag=${encodeURIComponent(tag)}${fresh ? "&fresh=1" : ""}`).catch(() => null);
    const j = r?.ok ? await r.json().catch(() => null) : null;
    return j?.ok ? (j as { state: string; ready: boolean; message: string | null }) : null;
  }, [tag]);
  useEffect(() => {
    let live = true;
    check(false).then((g) => { if (live) setGate(g); });
    return () => { live = false; };
  }, [check]);
  async function again() {
    setChecking(true);
    const g = await check(true);
    setChecking(false);
    if (!g) { toast.error("Couldn't read the Onboarding Form just now — try again in a moment."); return; }
    setGate(g);
    if (g.ready) { toast.success(`${tag}'s Onboarding Form is in.`); onReady?.(); }
    else toast.info("Still not in yet.");
  }
  if (!gate || gate.ready || gate.state === "unread") return null;
  return (
    <div role="status" className="flex flex-wrap items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-sm">
      <FileClock className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1 basis-72">
        <div className="font-medium">Waiting for the Onboarding Form</div>
        {/* The title already says it's waiting — the rest of the message says why. */}
        <p className="mt-0.5 text-muted-foreground">{(gate.message ?? "").replace(/^Waiting for .+? Onboarding Form — (.)/, (_, c: string) => c.toUpperCase())}</p>
        <p className="mt-1 text-xs text-muted-foreground">Until then, Set up in Reply Router and creating the campaigns can&apos;t run (the steps after the campaigns wait for them).</p>
      </div>
      <Button size="sm" variant="outline" onClick={again} disabled={checking}>
        {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check again
      </Button>
    </div>
  );
}

export function TagPill({ tag }: { tag: string }) {
  return <span className="font-mono text-xs font-bold bg-primary/10 text-primary px-2 py-0.5 rounded">{tag}</span>;
}
export function StatusPill({ status }: { status: TaskStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium", m.pill)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", m.dot)} />{m.label}
    </span>
  );
}
export function GroupBadge({ group }: { group: 1 | 2 | null }) {
  if (group !== 1 && group !== 2) {
    return <span className="text-[10px] font-medium rounded-full border border-dashed border-border px-1.5 py-0.5 text-muted-foreground">No group yet</span>;
  }
  const m = GROUP_META[group];
  return (
    <span title={`B2B #${group} ${m.b2b} + B2C #${group} ${m.b2c}`}
      className="text-[10px] font-medium rounded-full border border-violet-200 bg-violet-50 text-violet-700 px-1.5 py-0.5 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300">
      {m.label}
    </span>
  );
}
export function Progress({ done, total, className }: { done: number; total: number; className?: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const complete = total > 0 && done === total;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", complete ? "bg-green-500" : "bg-primary")} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums w-12 text-right">{done}/{total}</span>
    </div>
  );
}

// ─────────────────────────── task rules ───────────────────────────
export interface TaskGate {
  /** 1-based position among the client's ordered steps (null for dated tasks). */
  step: number | null;
  total: number;
  /** The earlier ordered step that has to be finished first, if any. */
  blocker: OnbTask | null;
  blockerStep: number | null;
}

/** A setup step: the in-order checklist steps, plus "Set up in Reply Router" (a day-0 task). */
export const isSetupStep = (t: OnbTask) => t.no_due || t.automation === "replyrouter_setup";

/** The client's setup steps in the order they're done — the same numbering on the checklist
 *  and the guided page: the in-order steps, with "Set up in Reply Router" right after Slack. */
export function setupSteps(clientTasks: OnbTask[]): OnbTask[] {
  const list = clientTasks.filter((t) => t.no_due).sort((a, b) => a.order_index - b.order_index);
  const rr = clientTasks.find((t) => t.automation === "replyrouter_setup");
  if (rr) {
    const i = list.findIndex((t) => t.automation === "slack_outreachify");
    list.splice(i >= 0 ? i + 1 : 0, 0, rr);
  }
  return list;
}

/** Where a task sits in its client's setup steps, and what (if anything) it waits on.
 *  Only the in-order steps wait on each other; Reply Router setup can run any time. */
export function taskGate(task: OnbTask, clientTasks: OnbTask[]): TaskGate {
  if (!isSetupStep(task)) return { step: null, total: 0, blocker: null, blockerStep: null };
  const ordered = setupSteps(clientTasks);
  const pos = (id: string) => ordered.findIndex((t) => t.id === id) + 1;
  const blocker = task.status === "completed" || !task.no_due ? null : blockingTask(task, clientTasks);
  return { step: pos(task.id) || null, total: ordered.length, blocker, blockerStep: blocker ? pos(blocker.id) : null };
}

export function dueInfo(task: OnbTask, gate: TaskGate, today: string): { text: string; tone: "muted" | "overdue" | "today" } {
  if (task.no_due || gate.step) return { text: gate.step ? `Step ${gate.step} of ${gate.total}` : "No due date", tone: "muted" };
  if (!task.due_date) return { text: "No due date", tone: "muted" };
  const open = task.status !== "completed";
  if (open && task.due_date < today) return { text: `${fmtDate(task.due_date)} · overdue`, tone: "overdue" };
  if (open && task.due_date === today) return { text: `${fmtDate(task.due_date)} · today`, tone: "today" };
  return { text: fmtDate(task.due_date), tone: "muted" };
}
export const DUE_TONE = {
  muted: "text-muted-foreground",
  overdue: "text-destructive font-medium",
  today: "text-blue-600 dark:text-blue-400 font-medium",
} as const;

export interface OwnerSection { ownerId: string; name: string; tasks: OnbTask[]; done: number; ordered: boolean; someOrdered: boolean }

/** A client's tasks split by owner, in checklist order (ordered steps first, then by due date). */
export function ownerSections(tasks: OnbTask[], usersById: Map<string, UserRow>): OwnerSection[] {
  const steps = setupSteps(tasks);
  const stepOrder = (t: OnbTask) => steps.findIndex((x) => x.id === t.id);
  const by = new Map<string, OnbTask[]>();
  for (const t of tasks) {
    const key = t.assignee_email || "";
    const arr = by.get(key);
    if (arr) arr.push(t); else by.set(key, [t]);
  }
  return [...by.entries()]
    .map(([ownerId, ts]) => ({
      ownerId,
      name: ownerId ? usersById.get(ownerId)?.name ?? "Former team member" : "Unassigned",
      tasks: ts.slice().sort((a, b) =>
        (isSetupStep(a) ? 0 : 1) - (isSetupStep(b) ? 0 : 1) ||
        (isSetupStep(a)
          ? stepOrder(a) - stepOrder(b)
          : (a.due_date || "9999").localeCompare(b.due_date || "9999") || a.order_index - b.order_index)),
      done: ts.filter((t) => t.status === "completed").length,
      ordered: ts.every(isSetupStep),
      someOrdered: ts.some(isSetupStep),
      first: Math.min(...ts.map((t) => t.order_index)),
    }))
    .sort((a, b) => (a.ownerId ? 0 : 1) - (b.ownerId ? 0 : 1) || a.first - b.first);
}

/** Status changes for task rows: one in flight at a time, errors as a toast. */
export function useStatusSetter(onChanged: () => void) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const setStatus = useCallback(async (id: string, status: TaskStatus) => {
    setBusyId(id);
    const r = await postMutate({ action: "update-task-status", id, status });
    setBusyId(null);
    if (r.ok) onChanged(); else toast.error(r.error || "Couldn't update the task");
  }, [onChanged]);
  return { busyId, setStatus };
}

// ─────────────────────────── task row pieces ───────────────────────────
export function StatusSelect({ task, gate, busy, onSet, className }: {
  task: OnbTask; gate: TaskGate; busy: boolean; onSet: (s: TaskStatus) => void; className?: string;
}) {
  return (
    // A locked step can't be started; one already in progress can still be set back.
    <Select value={task.status} onValueChange={(v) => onSet(v as TaskStatus)} disabled={busy || (!!gate.blocker && task.status === "not_started")}>
      <SelectTrigger className={cn("h-8 w-[7.5rem] text-xs shrink-0", className)}><SelectValue /></SelectTrigger>
      <SelectContent>
        {TASK_STATUS_ORDER.map((s) => <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** The row's main button: Run (automation), Complete (check-off), or why it's locked. */
export function TaskAction({ task, gate, isAdmin, busy, onRun, onComplete }: {
  task: OnbTask; gate: TaskGate; isAdmin: boolean; busy: boolean; onRun: () => void; onComplete: () => void;
}) {
  if (task.status === "completed") return null;
  const auto = task.automation ? AUTOMATION_META[task.automation] : null;
  if (gate.blocker) {
    return (
      <div className="flex items-center gap-2">
        {/* Looking at what a step would do changes nothing, so it's allowed ahead of its turn. */}
        {auto?.preview && !auto.built && isAdmin && (
          <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-primary" onClick={onRun} disabled={busy}>
            <Zap className="h-3.5 w-3.5" /> Preview
          </Button>
        )}
        <span title={`Finish “${gate.blocker.title}” first — these steps run in order.`}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-dashed px-2.5 text-xs text-muted-foreground whitespace-nowrap">
          <Lock className="h-3 w-3" /> After step {gate.blockerStep}
        </span>
      </div>
    );
  }
  if ((auto?.built || task.runnable) && isAdmin) {
    return (
      <Button size="sm" className="h-8 gap-1.5" onClick={onRun} disabled={busy}>
        <Zap className="h-3.5 w-3.5" /> Run
      </Button>
    );
  }
  // Not runnable yet, but it can show what it would do — done by hand meanwhile.
  if (auto?.preview && isAdmin) {
    return (
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-primary" onClick={onRun} disabled={busy}>
          <Zap className="h-3.5 w-3.5" /> Preview
        </Button>
        <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onComplete} disabled={busy}>
          <Check className="h-3.5 w-3.5" /> Complete
        </Button>
      </div>
    );
  }
  return (
    <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onComplete} disabled={busy}>
      <Check className="h-3.5 w-3.5" /> Complete
    </Button>
  );
}

/** What kind of step it is + how its last run / completion went. */
export function TaskNotes({ task }: { task: OnbTask }) {
  const auto = task.automation ? AUTOMATION_META[task.automation] : null;
  const done = task.status === "completed";
  return (
    <>
      {auto && !done && (
        <div className={cn("mt-1 flex items-start gap-1 text-xs", auto.built || task.runnable ? "text-primary" : "text-amber-700 dark:text-amber-400")}>
          <Zap className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {auto.built || task.runnable ? auto.label
              : auto.preview ? `${auto.label} — preview ready; it can't be run from here yet, complete it by hand for now`
              : `${auto.label} — automation coming, complete it by hand for now`}
          </span>
        </div>
      )}
      {task.last_run && !task.last_run.ok && !done && (
        <div className="mt-1 flex items-start gap-1 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>Last run failed — {task.last_run.summary}</span>
        </div>
      )}
      {done && (task.completed_at || task.completed_by || task.last_run?.ok) && (
        <div className="mt-1 text-xs text-muted-foreground">
          Done{task.completed_at ? ` ${fmtStamp(task.completed_at)}` : ""}
          {task.completed_by ? ` by ${shortEmail(task.completed_by)}` : ""}
          {task.last_run?.ok ? ` · ${task.last_run.summary}` : ""}
        </div>
      )}
    </>
  );
}

// ─────────────────────────── checklist ───────────────────────────
/**
 * One client's checklist: a section per owner, ordered steps numbered and
 * locked until the step before them is done. `editable` adds the per-task edit
 * button (owner, due date, delete) — used on the client page.
 */
export function ClientChecklist({ client, tasks, users, isAdmin, onChanged, editable = false }: {
  client: OnbClient; tasks: OnbTask[]; users: UserRow[]; isAdmin: boolean; onChanged: () => void; editable?: boolean;
}) {
  const today = todayStr();
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const sections = useMemo(() => ownerSections(tasks, usersById), [tasks, usersById]);
  const { busyId, setStatus } = useStatusSetter(onChanged);
  const [runTask, setRunTask] = useState<OnbTask | null>(null);
  const [editTask, setEditTask] = useState<OnbTask | null>(null);

  if (!tasks.length) {
    return <div className="py-10 text-center text-sm text-muted-foreground">No tasks yet.</div>;
  }

  return (
    <div className="space-y-5">
      {sections.map((s) => (
        <section key={s.ownerId || "none"} className="space-y-2">
          <div className="flex items-center gap-2.5 px-1">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              {s.name.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold leading-tight">{s.name}</div>
              <div className="text-[11px] text-muted-foreground">
                {s.ordered ? "Runs in order · no due dates" : s.someOrdered ? "Setup steps in order, then the rest by due date" : "Due by day from the start date"}
              </div>
            </div>
            <span className={cn("ml-auto text-xs tabular-nums", s.done === s.tasks.length ? "text-green-600 dark:text-green-400 font-medium" : "text-muted-foreground")}>
              {s.done}/{s.tasks.length} done
            </span>
          </div>
          <div className="overflow-hidden rounded-xl border bg-card divide-y">
            {s.tasks.map((t) => {
              const gate = taskGate(t, tasks);
              const due = dueInfo(t, gate, today);
              const done = t.status === "completed";
              const busy = busyId === t.id;
              return (
                <div key={t.id} className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3 transition-colors", gate.blocker && "bg-muted/20")}>
                  <span className={cn(
                    "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums",
                    done ? "bg-green-500 text-white"
                      : t.status === "in_progress" ? "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                      : gate.blocker ? "bg-muted text-muted-foreground/60" : "bg-muted text-muted-foreground")}>
                    {done ? <Check className="h-3.5 w-3.5" /> : gate.step ?? <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_META[t.status].dot)} />}
                  </span>
                  <div className="min-w-0 flex-1 basis-64">
                    <div className={cn("text-sm font-medium leading-snug", done && "text-muted-foreground line-through decoration-muted-foreground/40", gate.blocker && "text-muted-foreground")}>
                      {t.title}
                    </div>
                    <div className="mt-0.5 text-xs tabular-nums">
                      {!t.no_due && t.template_task_id && <span className="text-muted-foreground">Day {t.day_offset} · </span>}
                      <span className={DUE_TONE[due.tone]}>
                        {due.text}{t.due_date_overridden ? " · edited" : ""}
                      </span>
                    </div>
                    <TaskNotes task={t} />
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {editable && (
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground" title="Edit task" onClick={() => setEditTask(t)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <StatusSelect task={t} gate={gate} busy={busy} onSet={(v) => setStatus(t.id, v)} />
                    <TaskAction task={t} gate={gate} isAdmin={isAdmin} busy={busy}
                      onRun={() => setRunTask(t)} onComplete={() => setStatus(t.id, "completed")} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {runTask && (
        <RunDialog task={runTask} clientLabel={client.client_name ? `${client.client_tag} · ${client.client_name}` : client.client_tag}
          onClose={() => setRunTask(null)} onDone={onChanged} />
      )}
      {editTask && (
        <EditTaskDialog task={editTask} users={users} isAdmin={isAdmin} onClose={() => setEditTask(null)} onChanged={onChanged} />
      )}
    </div>
  );
}

// ─────────────────────────── Run dialog ───────────────────────────
type PreviewInput = {
  key: string; label: string; type: "group" | "text" | "select" | "textarea" | "hidden"; value: number | string | null;
  hint?: string; placeholder?: string; options?: { value: string; label: string }[];
};
type Preview = {
  title: string; lines: string[]; message?: string; inputs: PreviewInput[]; blockers: string[];
  tables?: { title: string; columns: string[]; rows: string[][] }[];
  notes?: { title: string; text: string }[];
};

async function postRun(taskId: string, mode: "preview" | "run", params: Record<string, unknown>) {
  const res = await fetch("/api/onboarding/run", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId, mode, params }),
  });
  if (res.status === 401) { window.location.href = "/login"; }
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; more?: boolean; preview?: Preview; runnable?: boolean; summary?: string; error?: string };
  return { status: res.status, data };
}

const isTyped = (i: PreviewInput) => i.type === "text" || i.type === "textarea";

/**
 * A step's preview and run, shared by the Run dialog and the guided onboarding
 * page: loads the preview, re-previews on every change, runs (in batches when
 * the step works in batches) and reports back.
 */
export function useStepRun(task: OnbTask, { onDone, onSuccess }: { onDone: () => void; onSuccess: (summary: string) => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Text fields are typed locally and sent when the field is left (or on Enter).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const focused = useRef<string | null>(null);
  // Previews are numbered: only the answer to the LATEST request is shown, and
  // Run sends the choices that produced what is on screen — never anything else.
  const latest = useRef(0);
  const [shown, setShown] = useState<Record<string, unknown>>({});
  // Whether this step can be run is the server's call (some are preview-only until switched on).
  // Start from the server's switch state (task.runnable) so an automatic step shows
  // "Approve & run" while its preview loads; the preview's answer then confirms it.
  const [canRun, setCanRun] = useState(!!(task.runnable ?? (task.automation && AUTOMATION_META[task.automation]?.built)));

  // "Approve & run" clicked while the preview was refreshing (e.g. right after typing in a field):
  // the run waits for the new preview and then goes ahead — unless that preview has something in the way.
  const queued = useRef(false);
  const [waiting, setWaiting] = useState(false);
  const runNext = useRef<(p: Preview, s: Record<string, unknown>) => void>(() => {});
  const showPreview = useCallback(({ status, data }: Awaited<ReturnType<typeof postRun>>, forParams: Record<string, unknown>) => {
    setLoading(false);
    if (data.preview) {
      const p = data.preview;
      setPreview(p); setError(null); setShown(forParams);
      if (typeof data.runnable === "boolean") setCanRun(data.runnable);
      // Take the server's values, except for the field being typed in right now.
      setDrafts((prev) => Object.fromEntries(p.inputs.filter(isTyped)
        .map((i) => [i.key, focused.current === i.key && i.key in prev ? prev[i.key] : String(i.value ?? "")])));
      if (queued.current) {
        queued.current = false; setWaiting(false);
        if (!p.blockers.length && data.runnable !== false) runNext.current(p, forParams);
        else toast.info("Not run — the updated preview has something to sort out first.");
      }
    } else {
      setError(data.error || `Couldn't load the preview (${status})`);
      if (queued.current) { queued.current = false; setWaiting(false); }
    }
  }, []);
  useEffect(() => {
    let alive = true;
    const mine = ++latest.current;
    postRun(task.id, "preview", {}).then((r) => { if (alive && mine === latest.current) showPreview(r, {}); });
    return () => { alive = false; };
  }, [task.id, showPreview]);

  async function setParam(key: string, value: unknown) {
    const next = { ...params, [key]: value };
    setParams(next);
    setLoading(true);
    const mine = ++latest.current;
    const r = await postRun(task.id, "preview", next);
    // An older answer arriving late must not replace a newer one (stays "loading" until the latest lands).
    if (mine === latest.current) showPreview(r, next);
  }
  function commitText(key: string) {
    focused.current = null;
    const current = preview?.inputs.find((i) => i.key === key);
    if (current && (drafts[key] ?? "") !== String(current.value ?? "")) setParam(key, drafts[key] ?? "");
  }

  // A step done in batches reports each one here and is sent again until nothing is left.
  const [progress, setProgress] = useState<string[]>([]);
  // The domains step works through LeadSync, a batch at a time: while it runs, LeadSync's own
  // progress for the batch in hand is polled, so the screen shows what is happening (tagging,
  // redirect, each campaign, …) instead of a bare "Running…".
  const [live, setLive] = useState<LiveBatch | null>(null);
  const liveRun = useRef<{ since: number; starts: string[] }>({ since: 0, starts: [] });
  useEffect(() => {
    if (!running || task.automation !== "allocate_domains") return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/onboarding/progress?taskId=${encodeURIComponent(task.id)}`, { cache: "no-store" });
        const j = (await res.json().catch(() => null)) as { progress?: Omit<LiveBatch, "n"> | null } | null;
        const p = j?.progress;
        // Only this run's batches: LeadSync keeps the last one for an hour (2 minutes' leeway for clocks).
        if (!alive || !p || Date.parse(p.startedAt) < liveRun.current.since - 120_000) return;
        const starts = liveRun.current.starts;
        if (!starts.includes(p.startedAt)) starts.push(p.startedAt);
        setLive({ ...p, n: starts.indexOf(p.startedAt) + 1 });
      } catch { /* the next tick tries again */ }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [running, task.id, task.automation]);
  const stop = useRef(false);
  const gone = useRef(false);
  // Leaving the page (or closing the dialog) stops a running loop after the request in flight.
  useEffect(() => { gone.current = false; return () => { gone.current = true; stop.current = true; }; }, []);
  const showFailure = (msg: string) => {
    toast.error(msg.length > 220 ? `${msg.slice(0, 217)}…` : msg, { duration: 10_000 });
    requestAnimationFrame(() => document.getElementById(`run-error-${task.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };
  async function runWith(p: Preview | null, values: Record<string, unknown>) {
    setRunning(true); setError(null);
    stop.current = false;
    liveRun.current = { since: Date.now(), starts: [] };
    setLive(null);
    // Exactly what's on screen is what runs: every value the preview showed (incl. hidden ones, like
    // which copy version it was), with what was typed on top — nothing is worked out again later.
    const approved = { ...Object.fromEntries((p?.inputs ?? []).map((i) => [i.key, i.value])), ...values };
    let batches = 0;
    try {
      for (let round = 0; round < 40; round++) {
        const { status, data } = await postRun(task.id, "run", approved);
        onDone(); // the task shows the batch, or keeps a note of the failed run
        if (!data.ok) {
          const msg = data.error || `The run failed (${status})`;
          if (data.preview) setPreview(data.preview);
          // When it's exactly what the preview lists as in the way, the amber box already says it.
          const same = !!data.preview?.blockers.length && data.preview.blockers.join(" ") === msg;
          setError(same ? null : msg);
          if (!gone.current) showFailure(same ? "Can't run yet — see what's in the way." : msg);
          break;
        }
        if (!data.more) { onSuccess(data.summary || "Done"); return; }
        batches++;
        setProgress((pr) => [...pr, data.summary || "A batch went through."]);
        if (stop.current) {
          if (!gone.current) {
            toast.info(`Stopped after ${batches} batch${batches === 1 ? "" : "es"} — run it again to carry on.`);
            // The plan on screen still shows the start; ask for the current one.
            setLoading(true);
            const mine = ++latest.current;
            postRun(task.id, "preview", values).then((r) => { if (mine === latest.current) showPreview(r, values); });
          }
          break;
        }
      }
    } catch (e) {
      // The request itself never came back (connection, timeout) — what it did is unknown.
      const msg = `The request didn't come back (${(e as Error).message}). It may still have gone through — reload this step and check it before running it again.`;
      setError(msg);
      if (!gone.current) showFailure(msg);
      onDone();
    } finally {
      // Always release the dialog, or it could never be closed.
      setRunning(false);
    }
  }
  runNext.current = (p, s) => { void runWith(p, s); };
  function run() {
    // A preview is being refreshed (a field was just left): run once it's in.
    if (loading) { queued.current = true; setWaiting(true); return; }
    void runWith(preview, shown);
  }

  return {
    preview, loading, running, error, canRun, drafts, setDrafts, focused, progress, live, setParam, commitText, run, waiting,
    stopAfterBatch: () => { stop.current = true; },
    blocked: !preview || preview.blockers.length > 0,
  };
}
export type StepRun = ReturnType<typeof useStepRun>;

/** LeadSync's progress for the batch in hand (lib/leadsync BatchProgress), and which batch of this run it is. */
type LiveBatch = {
  n: number; clientTag: string; instance: string; domains: string[]; startedAt: string; updatedAt: string;
  phase: "running" | "checking" | "done" | "problems";
  steps: { label: string; state: string; note?: string }[];
  problems?: string[];
};

const INSTANCE_NAME: Record<string, string> = { outboundhero: "B2B #1", cleaningoutbound: "B2C #1", facilityreach: "B2B #2", outboundclean: "B2C #2" };

/** LeadSync's runner step labels, said plainly. */
function stepText(label: string): string {
  let m: RegExpMatchArray | null;
  if ((m = label.match(/^Tag (\d+) reserve domain\(s\) → (.+)$/))) return `Tag the ${m[1]} domain${m[1] === "1" ? "" : "s"} for ${m[2]}`;
  if ((m = label.match(/^Set redirect → (.+)$/))) return m[1] === "(none)" ? "Redirect — no website to point at" : `Point their redirect at ${m[1]}`;
  if ((m = label.match(/^Attach to "(.+)"$/))) return `Attach their inboxes to “${m[1]}”`;
  if (/^Add to client domains sheet$/.test(label)) return "Add them to the client's sheet (Domains tab)";
  if (/^Queue whitelist email/.test(label)) return "Queue the whitelisting email (LeadSync sends it at 6:30 AM PT)";
  return label;
}

function StepIcon({ state }: { state: string }) {
  // One fixed box, so every row's text starts at the same place whatever the icon.
  const icon = state === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
    : state === "done" ? <Check className="h-3.5 w-3.5 text-green-600" />
    : state === "failed" ? <X className="h-3.5 w-3.5 text-destructive" />
    : state === "degraded" ? <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
    : state === "skipped" ? <Minus className="h-3.5 w-3.5 text-muted-foreground" />
    : <Circle className="h-2.5 w-2.5 text-muted-foreground/50" />; // queued
  return <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">{icon}</span>;
}

/** The runner's notes, said plainly ("+245" on an attach is the inboxes it attached). */
const noteText = (note: string) => (/^\+\d+$/.test(note) ? `${note.slice(1)} inboxes` : note);

const clock = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

/** What LeadSync is doing for the batch in hand, step by step — so a run that takes minutes visibly moves. */
function LiveBatchPanel({ live, running }: { live: LiveBatch | null; running: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  // It opens below a long plan, and grows as the steps come in: bring its top into view once,
  // when the run starts, so the whole list is on screen.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, []);
  const finished = live?.phase === "done" || live?.phase === "problems";
  const secs = live ? Math.max(0, Math.round(((finished ? Date.parse(live.updatedAt) : now) - Date.parse(live.startedAt)) / 1000)) : 0;
  const plural = (n: number) => (n === 1 ? "" : "s");
  return (
    <div ref={box} className="scroll-mt-6 rounded-lg border border-primary/25 bg-primary/[0.03] px-3 py-2.5 text-sm" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 font-medium">
          {!live || !finished
            ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
            : live.phase === "problems" ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" /> : <Check className="h-3.5 w-3.5 shrink-0 text-green-600" />}
          <span className="truncate">
            {live ? `Batch ${live.n} · ${live.domains.length} domain${plural(live.domains.length)} on ${INSTANCE_NAME[live.instance] ?? live.instance}` : "Live from LeadSync"}
          </span>
        </div>
        {live && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{clock(secs)}</span>}
      </div>
      {live && <div className="mt-0.5 truncate text-xs text-muted-foreground" title={live.domains.join(", ")}>{live.domains.join(", ")}</div>}
      <ul className="mt-2 space-y-1">
        {(!live || (live.steps.length === 0 && live.phase === "running")) && (
          <li className="flex gap-1.5"><StepIcon state="running" />LeadSync is checking the plan and the client&apos;s campaigns before it starts…</li>
        )}
        {live?.steps.map((s, i) => (
          <li key={i} className="flex gap-1.5">
            <StepIcon state={s.state} />
            <span>{stepText(s.label)}{s.note && <span className="text-muted-foreground"> — {noteText(s.note)}</span>}</span>
          </li>
        ))}
        {live && live.phase !== "running" && (
          <li className="flex gap-1.5">
            <StepIcon state={live.phase === "checking" ? "running" : live.phase === "done" ? "done" : "failed"} />
            Check every step went through, then set every sender to 3 a day
          </li>
        )}
      </ul>
      {live?.phase === "problems" && !!live.problems?.length && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-destructive">{live.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
      )}
      {running && live?.phase === "done" && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Batch {live.n} is in — LeadSync is drawing up the next one…
        </div>
      )}
    </div>
  );
}

/** What a step will do: its choices, the plan, the message / tables / notes, and what's in the way. */
export function StepRunBody({ task, r }: { task: OnbTask; r: StepRun }) {
  const { preview, loading, running, drafts, setDrafts, focused, setParam, commitText, progress, live, error } = r;
  const fields = preview?.inputs.filter((i) => i.type !== "group" && i.type !== "hidden") ?? [];
  // Name / email pairs (CC 1, CC 2, …) sit two to a row so each pair stays together.
  const paired = fields.some((i) => /_name$/.test(i.key)) && fields.some((i) => /_email$/.test(i.key));
  return (
    <>
      {!preview && loading && (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Preparing the preview…
        </div>
      )}

      {preview && (
        <div className={cn("space-y-4 transition-opacity", loading && "opacity-60")}>
          {preview.inputs.map((inp) => inp.type === "group" && (
            <div key={inp.key} className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">{inp.label}</div>
              <div className="grid grid-cols-2 gap-2">
                {([1, 2] as const).map((g) => {
                  const selected = Number(inp.value) === g;
                  return (
                    <button key={g} type="button" disabled={running} onClick={() => setParam(inp.key, g)}
                      className={cn("rounded-lg border px-3 py-2.5 text-left transition-colors",
                        selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:border-primary/40 hover:bg-muted/40")}>
                      <div className="flex items-center justify-between text-sm font-semibold">
                        {GROUP_META[g].label}
                        {selected && <Check className="h-4 w-4 text-primary" />}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">B2B #{g} {GROUP_META[g].b2b}</div>
                      <div className="text-xs text-muted-foreground">B2C #{g} {GROUP_META[g].b2c}</div>
                    </button>
                  );
                })}
              </div>
              {inp.hint && <div className="text-xs text-muted-foreground">{inp.hint}</div>}
            </div>
          ))}

          {fields.length > 0 && (
            <div className={cn("grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2", !paired && "xl:grid-cols-3")}>
              {fields.map((inp) => (
                <div key={inp.key} className={cn("space-y-1.5",
                  inp.type === "textarea" ? (paired ? "sm:col-span-2" : "sm:col-span-2 xl:col-span-3")
                  // In the paired layout anything that isn't half of a pair takes the whole row, so the pairs line up.
                  : paired && !/_(name|email)$/.test(inp.key) && "sm:col-span-2")}>
                  <label htmlFor={`run-${inp.key}`} className="text-xs font-medium text-muted-foreground">{inp.label}</label>
                  {inp.type === "select" ? (
                    <Select value={String(inp.value ?? "")} onValueChange={(v) => setParam(inp.key, v)} disabled={running}>
                      <SelectTrigger id={`run-${inp.key}`} className="h-9 w-full text-sm"><SelectValue placeholder="Choose…" /></SelectTrigger>
                      <SelectContent>
                        {(inp.options ?? []).map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : inp.type === "textarea" ? (
                    <Textarea id={`run-${inp.key}`} value={drafts[inp.key] ?? ""} placeholder={inp.placeholder} disabled={running} spellCheck={false}
                      className="min-h-20 font-mono text-[12.5px] leading-relaxed"
                      onFocus={() => { focused.current = inp.key; }}
                      onChange={(e) => setDrafts((d) => ({ ...d, [inp.key]: e.target.value }))}
                      onBlur={() => commitText(inp.key)} />
                  ) : (
                    <Input id={`run-${inp.key}`} value={drafts[inp.key] ?? ""} placeholder={inp.placeholder} disabled={running} className="h-9"
                      onFocus={() => { focused.current = inp.key; }}
                      onChange={(e) => setDrafts((d) => ({ ...d, [inp.key]: e.target.value }))}
                      onBlur={() => commitText(inp.key)}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                  )}
                  {inp.hint && <p className="text-[11px] leading-snug text-muted-foreground">{inp.hint}</p>}
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">{r.canRun ? "What happens when you run it" : "What it would do"}</div>
            <ol className="space-y-1 text-sm">
              {preview.lines.map((l, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold tabular-nums text-muted-foreground">{i + 1}</span>
                  <span>{l}</span>
                </li>
              ))}
            </ol>
          </div>

          {preview.message && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                {task.automation === "slack_outreachify"
                  ? <>The message, exactly as it will be sent <span className="font-normal">(Slack shows *text* in bold)</span></>
                  : "The email, exactly as it will be sent"}
              </div>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 px-3 py-2.5 font-sans text-[13px] leading-relaxed">{preview.message}</pre>
            </div>
          )}

          {preview.tables?.map((t) => (
            <div key={t.title} className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">{t.title}</div>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-left text-muted-foreground">
                    <tr>{t.columns.map((col) => <th key={col} className="px-2.5 py-1.5 font-medium whitespace-nowrap">{col}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y">
                    {t.rows.map((row, i) => (
                      <tr key={i}>{row.map((cell, j) => {
                        // The main column: the name in wider tables (after a short label column), the first in two-column ones.
                        const main = t.columns.length > 2 ? j === 1 : j === 0;
                        return <td key={j} className={cn("px-2.5 py-1.5 align-top", main ? "min-w-48 font-medium" : "whitespace-nowrap text-muted-foreground")}>{cell}</td>;
                      })}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {preview.notes?.map((n) => (
            <div key={n.title} className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">{n.title}</div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 px-3 py-2.5 font-mono text-[11px] leading-relaxed">{n.text}</pre>
            </div>
          ))}

          {preview.blockers.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
              <div className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-3.5 w-3.5" /> {r.canRun ? "Can't run yet" : "Check first"}</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {preview.blockers.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {task.automation === "allocate_domains" && (running || live?.phase === "problems") && <LiveBatchPanel live={live} running={running} />}

      {progress.length > 0 && (
        <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
          <div className="text-xs font-medium text-muted-foreground">Done so far{running ? " — working on the next batch…" : ""}</div>
          <ul className="mt-1 space-y-0.5">
            {progress.map((line, i) => <li key={i} className="flex gap-1.5"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" />{line}</li>)}
          </ul>
        </div>
      )}

      {error && (
        <div id={`run-error-${task.id}`} role="alert" className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span>
        </div>
      )}
    </>
  );
}

/**
 * The Run button's dialog: shows exactly what the automation will do (who gets
 * what message, what changes) before anything happens, then runs it. Mounted
 * only while a task is being run.
 */
export function RunDialog({ task, clientLabel, onClose, onDone }: {
  task: OnbTask; clientLabel: string; onClose: () => void; onDone: () => void;
}) {
  const r = useStepRun(task, { onDone, onSuccess: (summary) => { toast.success(summary); onClose(); } });
  const wide = !!r.preview?.tables?.length || !!r.preview?.inputs.some((i) => i.type === "textarea");
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !r.running) onClose(); }}>
      <DialogContent className={cn("max-h-[90vh] overflow-y-auto", wide ? "sm:max-w-5xl" : "sm:max-w-xl")}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Zap className="h-4 w-4 text-primary" />{r.preview?.title ?? task.title}</DialogTitle>
          <DialogDescription>{clientLabel} — {r.canRun ? "review what will happen, then run it." : "a preview of what this step will do. Nothing is created."}</DialogDescription>
        </DialogHeader>
        <StepRunBody task={task} r={r} />
        <DialogFooter>
          {r.running && r.progress.length > 0 && (
            <Button variant="ghost" onClick={r.stopAfterBatch} className="sm:mr-auto text-muted-foreground">Stop after this batch</Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={r.running}>{r.canRun ? "Cancel" : "Close"}</Button>
          {r.canRun && (
            <Button onClick={r.run} disabled={r.blocked || r.loading || r.running} className="gap-1.5">
              {r.running ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Running…</> : <><Zap className="h-3.5 w-3.5" /> Run &amp; mark done</>}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────── Edit task dialog ───────────────────────────
/** Owner, due date and delete for one task (the client page's pencil button). */
function EditTaskDialog({ task, users, isAdmin, onClose, onChanged }: {
  task: OnbTask; users: UserRow[]; isAdmin: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [assignee, setAssignee] = useState(task.assignee_email || "");
  const [due, setDue] = useState(task.due_date || "");
  const [busy, setBusy] = useState(false);
  const assigneeChanged = assignee !== (task.assignee_email || "");
  const dueChanged = !!due && due !== (task.due_date || "");

  async function save() {
    setBusy(true);
    const errors: string[] = [];
    if (assigneeChanged) {
      const r = await postMutate({ action: "update-task-assignee", id: task.id, assignee_email: assignee || null });
      if (!r.ok) errors.push(r.error || "Couldn't change the owner");
    }
    if (dueChanged) {
      const r = await postMutate({ action: "update-task-due-date", id: task.id, due_date: due });
      if (!r.ok) errors.push(r.error || "Couldn't change the due date");
    }
    setBusy(false);
    onChanged();
    if (errors.length) { toast.error(errors.join(" · ")); return; }
    toast.success("Task updated");
    onClose();
  }
  async function remove() {
    setBusy(true);
    const r = await postMutate({ action: "delete-task", id: task.id });
    setBusy(false);
    if (r.ok) { toast.success("Task deleted"); onChanged(); onClose(); } else toast.error(r.error || "Couldn't delete the task");
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit task</DialogTitle>
          <DialogDescription>{task.title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Owner</label>
            <Select value={assignee || UNASSIGNED} onValueChange={(v) => setAssignee(v === UNASSIGNED ? "" : v)}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Unassigned" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>— Unassigned —</SelectItem>
                {users.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {assigneeChanged && assignee && <p className="text-[11px] text-muted-foreground">The new owner gets a Slack message about this task.</p>}
          </div>
          {task.no_due ? (
            <p className="text-xs text-muted-foreground">This step has no due date — it runs in checklist order.</p>
          ) : isAdmin && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Due date</label>
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
          )}
        </div>
        <DialogFooter className="sm:justify-between">
          {isAdmin
            ? <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={remove} disabled={busy}>Delete task</Button>
            : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button onClick={save} disabled={busy || (!assigneeChanged && !dueChanged)}>{busy ? "Saving…" : "Save"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
