"use client";

/**
 * Onboarding UI shared by the list page and the client page: the data shapes,
 * the mutate helper, and the checklist itself (owner sections → task lines →
 * the Run dialog).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, Loader2, Lock, Pencil, Zap } from "lucide-react";
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
  const [canRun, setCanRun] = useState(!!(task.automation && AUTOMATION_META[task.automation]?.built));

  const showPreview = useCallback(({ status, data }: Awaited<ReturnType<typeof postRun>>, forParams: Record<string, unknown>) => {
    setLoading(false);
    if (data.preview) {
      const p = data.preview;
      setPreview(p); setError(null); setShown(forParams);
      if (typeof data.runnable === "boolean") setCanRun(data.runnable);
      // Take the server's values, except for the field being typed in right now.
      setDrafts((prev) => Object.fromEntries(p.inputs.filter(isTyped)
        .map((i) => [i.key, focused.current === i.key && i.key in prev ? prev[i.key] : String(i.value ?? "")])));
    } else setError(data.error || `Couldn't load the preview (${status})`);
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
  const stop = useRef(false);
  async function run() {
    setRunning(true); setError(null);
    stop.current = false;
    // Exactly what's on screen is what runs: every value the preview showed (incl. hidden ones, like
    // which copy version it was), with what was typed on top — nothing is worked out again later.
    const approved = { ...Object.fromEntries((preview?.inputs ?? []).map((i) => [i.key, i.value])), ...shown };
    try {
      for (let round = 0; round < 40; round++) {
        const { status, data } = await postRun(task.id, "run", approved);
        onDone(); // the task shows the batch, or keeps a note of the failed run
        if (!data.ok) {
          setError(data.error || `The run failed (${status})`);
          if (data.preview) setPreview(data.preview);
          break;
        }
        if (!data.more) { onSuccess(data.summary || "Done"); return; }
        setProgress((p) => [...p, data.summary || "A batch went through."]);
        if (stop.current) break;
      }
    } catch (e) {
      // The request itself never came back (connection, timeout) — what it did is unknown.
      setError(`The request didn't come back (${(e as Error).message}). It may still have gone through — close this, look at the step, and open its preview before running it again.`);
      onDone();
    } finally {
      // Always release the dialog, or it could never be closed.
      setRunning(false);
    }
  }

  return {
    preview, loading, running, error, canRun, drafts, setDrafts, focused, progress, setParam, commitText, run,
    stopAfterBatch: () => { stop.current = true; },
    blocked: !preview || preview.blockers.length > 0,
  };
}
export type StepRun = ReturnType<typeof useStepRun>;

/** What a step will do: its choices, the plan, the message / tables / notes, and what's in the way. */
export function StepRunBody({ task, r }: { task: OnbTask; r: StepRun }) {
  const { preview, loading, running, drafts, setDrafts, focused, setParam, commitText, progress, error } = r;
  const fields = preview?.inputs.filter((i) => i.type !== "group" && i.type !== "hidden") ?? [];
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
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3">
              {fields.map((inp) => (
                <div key={inp.key} className={cn("space-y-1.5", inp.type === "textarea" && "sm:col-span-3")}>
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
            <div className="text-xs font-medium text-muted-foreground">What happens when you run it</div>
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
                      <tr key={i}>{row.map((cell, j) => <td key={j} className={cn("px-2.5 py-1.5 align-top whitespace-nowrap", j === 1 ? "font-medium" : "text-muted-foreground")}>{cell}</td>)}</tr>
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
              <div className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-3.5 w-3.5" /> Can&apos;t run yet</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {preview.blockers.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {progress.length > 0 && (
        <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
          <div className="text-xs font-medium text-muted-foreground">Done so far{running ? " — working on the next batch…" : ""}</div>
          <ul className="mt-1 space-y-0.5">
            {progress.map((line, i) => <li key={i} className="flex gap-1.5"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" />{line}</li>)}
          </ul>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">{error}</div>
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
