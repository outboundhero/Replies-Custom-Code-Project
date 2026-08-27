"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { useSession } from "@/components/session-provider";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger, DialogDescription,
} from "@/components/ui/dialog";
import { STATUS_META, TASK_STATUS_ORDER, ROLE_META, shortEmail, fmtDate, todayStr } from "@/lib/onboarding/ui";
import type { OnboardingRole, TaskStatus } from "@/lib/onboarding/generate";

type OnbClient = {
  client_tag: string; client_name: string | null; start_date: string;
  domains_owner_email: string | null; inbox_owner_email: string | null; ops_owner_email: string | null;
  status: string; tasks_total: number; tasks_done: number;
};
type OnbTask = {
  id: string; client_tag: string; title: string; role: OnboardingRole; task_group: string | null;
  day_offset: number; due_date: string | null; assignee_email: string | null; status: TaskStatus;
  order_index: number; due_date_overridden: number;
};

async function postMutate(body: Record<string, unknown>) {
  const res = await fetch("/api/onboarding/mutate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (res.status === 401) { window.location.href = "/login"; return { error: "unauthorized" }; }
  return res.json().catch(() => ({ error: `HTTP ${res.status}` })) as Promise<{ ok?: boolean; error?: string; [k: string]: unknown }>;
}

function TagPill({ tag }: { tag: string }) {
  return <span className="font-mono text-xs font-bold bg-primary/10 text-primary px-2 py-0.5 rounded">{tag}</span>;
}
function RolePill({ role }: { role: OnboardingRole }) {
  const m = ROLE_META[role];
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", m.pill)}>{m.short}</span>;
}

export default function ClientDetailPage() {
  const params = useParams();
  const router = useRouter();
  const session = useSession();
  const isAdmin = session?.role === "admin";
  const tag = decodeURIComponent(String(params.tag || "")).toUpperCase();

  const [client, setClient] = useState<OnbClient | null>(null);
  const [tasks, setTasks] = useState<OnbTask[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    try {
      const [b, u] = await Promise.all([fetch("/api/onboarding"), fetch("/api/onboarding/users")]);
      if (b.status === 401) { window.location.href = "/login"; return; }
      const data = await b.json();
      const c = (data.clients as OnbClient[]).find((x) => x.client_tag.toUpperCase() === tag) || null;
      setClient(c); setNotFound(!c);
      setTasks((data.tasks as OnbTask[]).filter((t) => t.client_tag.toUpperCase() === tag));
      if (u.ok) setUsers((await u.json() as { email: string }[]).map((x) => x.email));
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [tag]);

  useEffect(() => { load(); }, [load]);

  const sorted = useMemo(() =>
    tasks.slice().sort((a, b) => (a.due_date || "").localeCompare(b.due_date || "") || a.order_index - b.order_index),
    [tasks]);
  const done = tasks.filter((t) => t.status === "completed").length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const today = todayStr();

  // Group tasks by due date so the list reads as a timeline with colored day
  // headers (overdue / today / upcoming).
  const groups = useMemo(() => {
    const m = new Map<string, OnbTask[]>();
    for (const t of sorted) {
      const key = t.due_date || "no-date";
      const arr = m.get(key);
      if (arr) arr.push(t); else m.set(key, [t]);
    }
    return [...m.entries()];
  }, [sorted]);

  // Bulk selection + status.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) => setSelected((prev) => {
    const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n;
  });
  const clearSel = () => setSelected(new Set());
  async function bulkStatus(status: TaskStatus) {
    const ids = [...selected];
    if (!ids.length) return;
    const r = await postMutate({ action: "bulk-task-status", ids, status });
    if (r.ok) { toast.success(`${ids.length} task${ids.length === 1 ? "" : "s"} updated`); clearSel(); load(); }
    else toast.error(r.error || "Failed");
  }

  async function refresh(body: Record<string, unknown>, okMsg?: string) {
    const r = await postMutate(body);
    if (r.ok) { if (okMsg) toast.success(okMsg); load(); } else toast.error(r.error || "Failed");
  }

  if (loading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading…</div>;
  if (notFound || !client) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Link href="/onboarding" className="text-sm text-muted-foreground hover:underline">← Onboarding</Link>
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">
          <span className="font-mono font-bold">{tag}</span> isn&apos;t in onboarding.
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <Link href="/onboarding" className="text-sm text-muted-foreground hover:underline">← Onboarding</Link>

      {/* Header */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <TagPill tag={client.client_tag} />
              <div>
                <h2 className="text-xl font-semibold tracking-tight leading-none">{client.client_name || client.client_tag}</h2>
                <p className="text-xs text-muted-foreground mt-1">Started {fmtDate(client.start_date)}</p>
              </div>
            </div>
            {isAdmin && (
              <div className="flex items-center gap-2">
                <StartDateDialog tag={client.client_tag} current={client.start_date} onSaved={load} />
                <Select value={client.status === "completed" ? "completed" : "active"}
                  onValueChange={(v) => refresh({ action: "set-client-status", client_tag: client.client_tag, status: v }, "Status updated")}>
                  <SelectTrigger className="h-9 w-32 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Progress */}
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-sm text-muted-foreground tabular-nums">{done}/{tasks.length} · {pct}%</span>
          </div>

          {/* Owners */}
          <div className="flex flex-wrap gap-4 pt-1">
            {(["domains", "inbox", "ops"] as OnboardingRole[]).map((r) => {
              const email = r === "domains" ? client.domains_owner_email : r === "inbox" ? client.inbox_owner_email : client.ops_owner_email;
              return (
                <div key={r} className="flex items-center gap-1.5 text-sm">
                  <RolePill role={r} /><span className="text-muted-foreground">{email || "unassigned"}</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Tasks */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Tasks</h3>
          <AddTaskDialog tag={client.client_tag} users={users} onAdded={load} />
        </div>

        {/* Bulk action bar — appears when tasks are selected. */}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <span className="font-medium">{selected.size} selected</span>
            <span className="text-muted-foreground">· set status:</span>
            {TASK_STATUS_ORDER.map((s) => (
              <Button key={s} size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkStatus(s)}>
                {STATUS_META[s].label}
              </Button>
            ))}
            <button onClick={clearSel} className="ml-auto text-xs text-muted-foreground hover:text-foreground">Clear</button>
          </div>
        )}

        {sorted.length === 0 && (
          <Card><div className="py-10 text-center text-sm text-muted-foreground">No tasks.</div></Card>
        )}
        {groups.map(([key, ts]) => {
          const due = key === "no-date" ? null : key;
          const overdue = due && due < today;
          const isToday = due === today;
          const tint = !due ? "text-muted-foreground" : overdue ? "text-destructive" : isToday ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground";
          const dot = !due ? "bg-muted-foreground/40" : overdue ? "bg-destructive" : isToday ? "bg-blue-500" : "bg-muted-foreground/40";
          const label = !due ? "No due date" : overdue ? `Overdue · ${fmtDate(due)}` : isToday ? `Today · ${fmtDate(due)}` : fmtDate(due);
          return (
            <div key={key} className="space-y-1.5">
              <div className="flex items-center gap-2 px-1">
                <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
                <span className={cn("text-xs font-semibold", tint)}>{label}</span>
                <span className="text-[11px] text-muted-foreground">· {ts.length}</span>
              </div>
              <Card className="overflow-hidden"><div className="divide-y">
                {ts.map((t) => (
                  <TaskRow key={t.id} task={t} users={users} today={today} isAdmin={isAdmin}
                    selected={selected.has(t.id)} onToggle={() => toggleSel(t.id)} onChange={load} />
                ))}
              </div></Card>
            </div>
          );
        })}
      </div>

      {isAdmin && (
        <div className="flex items-center gap-2 pt-2">
          <Button variant="outline" size="sm"
            onClick={() => refresh({ action: "regenerate", client_tag: client.client_tag }, "Regenerated missing tasks")}>
            Regenerate missing tasks
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive"
            onClick={() => { if (confirm(`Remove ${client.client_tag} from onboarding? This deletes its tasks.`)) postMutate({ action: "delete-client", client_tag: client.client_tag }).then((r) => { if (r.ok) { toast.success("Removed"); router.push("/onboarding"); } else toast.error(r.error || "Failed"); }); }}>
            Remove from onboarding
          </Button>
        </div>
      )}
    </div>
  );
}

function TaskRow({ task, users, today, isAdmin, selected, onToggle, onChange }: {
  task: OnbTask; users: string[]; today: string; isAdmin: boolean;
  selected: boolean; onToggle: () => void; onChange: () => void;
}) {
  const overdue = task.status !== "completed" && task.due_date && task.due_date < today;
  const isToday = task.status !== "completed" && task.due_date === today;
  const UNASSIGNED = "—";

  async function mut(body: Record<string, unknown>, msg?: string) {
    const r = await postMutate(body);
    if (r.ok) { if (msg) toast.success(msg); onChange(); } else toast.error(r.error || "Failed");
  }

  return (
    <div className={cn("flex items-center gap-3 px-4 py-2.5 transition-colors", selected && "bg-primary/5")}>
      <input type="checkbox" checked={selected} onChange={onToggle}
        className="h-3.5 w-3.5 shrink-0 rounded border-muted-foreground/40 accent-primary cursor-pointer" />
      <div className={cn("h-2 w-2 rounded-full shrink-0", STATUS_META[task.status].dot)} />
      <div className="min-w-0 flex-1">
        <div className={cn("text-sm font-medium truncate", task.status === "completed" && "line-through text-muted-foreground")}>{task.title}</div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
          <RolePill role={task.role} />
          <span className={cn("tabular-nums", overdue && "text-destructive font-medium", isToday && "text-blue-600 dark:text-blue-400 font-medium")}>
            {fmtDate(task.due_date)}{task.due_date_overridden ? " ·edited" : ""}{overdue ? " · overdue" : ""}
          </span>
        </div>
      </div>
      {/* Assignee */}
      <Select value={task.assignee_email || UNASSIGNED} onValueChange={(v) => mut({ action: "update-task-assignee", id: task.id, assignee_email: v === UNASSIGNED ? null : v })}>
        <SelectTrigger className="h-8 w-40 text-xs shrink-0"><SelectValue placeholder="Unassigned" /></SelectTrigger>
        <SelectContent>
          <SelectItem value={UNASSIGNED}>— Unassigned —</SelectItem>
          {users.map((u) => <SelectItem key={u} value={u}>{shortEmail(u)}</SelectItem>)}
        </SelectContent>
      </Select>
      {/* Due date edit (admin) */}
      {isAdmin && (
        <Input type="date" value={task.due_date || ""} className="h-8 w-36 text-xs shrink-0"
          onChange={(e) => { if (e.target.value) mut({ action: "update-task-due-date", id: task.id, due_date: e.target.value }); }} />
      )}
      {/* Status */}
      <Select value={task.status} onValueChange={(v) => mut({ action: "update-task-status", id: task.id, status: v as TaskStatus })}>
        <SelectTrigger className="h-8 w-36 text-xs shrink-0"><SelectValue /></SelectTrigger>
        <SelectContent>{TASK_STATUS_ORDER.map((s) => <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>)}</SelectContent>
      </Select>
      {isAdmin && (
        <Button variant="ghost" size="sm" className="text-destructive shrink-0 h-8 px-2"
          onClick={() => mut({ action: "delete-task", id: task.id }, "Deleted")}>✕</Button>
      )}
    </div>
  );
}

function StartDateDialog({ tag, current, onSaved }: { tag: string; current: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(current);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const r = await postMutate({ action: "update-start-date", client_tag: tag, start_date: date });
    setBusy(false);
    if (r.ok) { toast.success("Start date updated — due dates recalculated"); setOpen(false); onSaved(); } else toast.error(r.error || "Failed");
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="outline" size="sm">Change start date</Button></DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Change start date</DialogTitle>
          <DialogDescription>Shifts every task&apos;s due date by the same offset. Manually-edited due dates are left untouched.</DialogDescription>
        </DialogHeader>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save & recalculate"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddTaskDialog({ tag, users, onAdded }: { tag: string; users: string[]; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [role, setRole] = useState<OnboardingRole>("ops");
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");
  const UNASSIGNED = "—";

  async function submit() {
    if (!title.trim()) { toast.error("Title required"); return; }
    setBusy(true);
    const r = await postMutate({ action: "add-task", client_tag: tag, title, role, assignee_email: assignee || null, due_date: due || null });
    setBusy(false);
    if (r.ok) { toast.success("Task added"); setOpen(false); setTitle(""); setAssignee(""); setDue(""); setRole("ops"); onAdded(); }
    else toast.error(r.error || "Failed");
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline">+ Add task</Button></DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Add a task</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" />
          <div className="grid grid-cols-2 gap-3">
            <Select value={role} onValueChange={(v) => setRole(v as OnboardingRole)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{(["domains", "inbox", "ops"] as OnboardingRole[]).map((r) => <SelectItem key={r} value={r}>{ROLE_META[r].label}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={assignee || UNASSIGNED} onValueChange={(v) => setAssignee(v === UNASSIGNED ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>— Unassigned —</SelectItem>
                {users.map((u) => <SelectItem key={u} value={u}>{shortEmail(u)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Due date (optional)</label>
            <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Adding…" : "Add task"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
