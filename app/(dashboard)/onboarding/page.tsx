"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useSession } from "@/components/session-provider";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import {
  STATUS_META, TASK_STATUS_ORDER, ROLE_META, shortEmail, fmtDate, todayStr,
} from "@/lib/onboarding/ui";
import type { OnboardingRole, TaskStatus } from "@/lib/onboarding/generate";

// ─────────────────────────── types ───────────────────────────
type OnbClient = {
  client_tag: string; client_name: string | null; start_date: string;
  domains_owner_email: string | null; inbox_owner_email: string | null; ops_owner_email: string | null;
  status: string; tasks_total: number; tasks_done: number;
};
type OnbTask = {
  id: string; client_tag: string; template_task_id: string | null; title: string;
  role: OnboardingRole; task_group: string | null; day_offset: number; due_date: string | null;
  assignee_email: string | null; status: TaskStatus; order_index: number; due_date_overridden: number;
};
type TemplateTask = {
  id: string; title: string; role: OnboardingRole; day_offset: number; order_index: number; task_group: string | null;
};
type UserRow = { email: string; role: string };

const UNASSIGNED = "—";

async function postMutate(body: Record<string, unknown>): Promise<{ ok?: boolean; error?: string; [k: string]: unknown }> {
  const res = await fetch("/api/onboarding/mutate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (res.status === 401) { window.location.href = "/login"; return { error: "unauthorized" }; }
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}

// ─────────────────────────── small bits ───────────────────────────
function StatusPill({ status }: { status: TaskStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium", m.pill)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", m.dot)} />{m.label}
    </span>
  );
}
function TagPill({ tag }: { tag: string }) {
  return <span className="font-mono text-xs font-bold bg-primary/10 text-primary px-2 py-0.5 rounded">{tag}</span>;
}
function RolePill({ role }: { role: OnboardingRole }) {
  const m = ROLE_META[role];
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", m.pill)}>{m.short}</span>;
}
function Progress({ done, total, className }: { done: number; total: number; className?: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums w-14 text-right">{done}/{total}</span>
    </div>
  );
}

// ─────────────────────────── page ───────────────────────────
export default function OnboardingPage() {
  const session = useSession();
  const isAdmin = session?.role === "admin";

  const [clients, setClients] = useState<OnbClient[]>([]);
  const [tasks, setTasks] = useState<OnbTask[]>([]);
  const [template, setTemplate] = useState<TemplateTask[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, u] = await Promise.all([fetch("/api/onboarding"), fetch("/api/onboarding/users")]);
      if (b.status === 401 || u.status === 401) { window.location.href = "/login"; return; }
      if (!b.ok) { setErr(`Failed to load (${b.status})`); return; }
      const data = await b.json();
      setClients(data.clients ?? []);
      setTasks(data.tasks ?? []);
      if (u.ok) setUsers(await u.json());
      setErr(null);
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, []);

  const loadTemplate = useCallback(async () => {
    const r = await fetch("/api/onboarding/template");
    if (r.ok) setTemplate(await r.json());
  }, []);

  useEffect(() => { load(); loadTemplate(); }, [load, loadTemplate]);

  const userEmails = useMemo(() => users.map((u) => u.email), [users]);

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Onboarding</h2>
          <p className="text-sm text-muted-foreground">
            Add a client to auto-generate its onboarding timeline — tasks, due dates, and owners.
          </p>
        </div>
        {isAdmin && (
          <AddClientDialog userEmails={userEmails} existingTags={clients.map((c) => c.client_tag)} onAdded={load} />
        )}
      </div>

      {err && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{err}</div>}

      <Tabs defaultValue="clients">
        <TabsList>
          <TabsTrigger value="clients">All Clients</TabsTrigger>
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="mine">My Tasks</TabsTrigger>
          {isAdmin && <TabsTrigger value="template">Template</TabsTrigger>}
        </TabsList>

        <TabsContent value="clients" className="mt-4">
          <AllClients clients={clients} loading={loading} />
        </TabsContent>
        <TabsContent value="board" className="mt-4">
          <Board tasks={tasks} clients={clients} userEmails={userEmails} myEmail={session?.email ?? null} onChange={load} />
        </TabsContent>
        <TabsContent value="mine" className="mt-4">
          <MyTasks tasks={tasks} myEmail={session?.email ?? null} onChange={load} />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="template" className="mt-4">
            <TemplateEditor template={template} onChange={loadTemplate} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// ─────────────────────────── All Clients ───────────────────────────
function AllClients({ clients, loading }: { clients: OnbClient[]; loading: boolean }) {
  if (loading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading…</div>;
  if (!clients.length) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          No clients in onboarding yet — add your first with <span className="font-medium text-foreground">Add to Onboarding</span>.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Client</TableHead>
            <TableHead>Start</TableHead>
            <TableHead>Owners</TableHead>
            <TableHead className="w-48">Progress</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {clients.map((c) => (
            <TableRow key={c.client_tag} className="cursor-pointer">
              <TableCell>
                <Link href={`/onboarding/${encodeURIComponent(c.client_tag)}`} className="flex items-center gap-2 hover:underline">
                  <TagPill tag={c.client_tag} />
                  {c.client_name && <span className="text-sm">{c.client_name}</span>}
                </Link>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{fmtDate(c.start_date)}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {(["domains", "inbox", "ops"] as OnboardingRole[]).map((r) => {
                    const email = r === "domains" ? c.domains_owner_email : r === "inbox" ? c.inbox_owner_email : c.ops_owner_email;
                    return (
                      <span key={r} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <RolePill role={r} /><span>{shortEmail(email) || "—"}</span>
                      </span>
                    );
                  })}
                </div>
              </TableCell>
              <TableCell><Progress done={c.tasks_done} total={c.tasks_total} /></TableCell>
              <TableCell>
                <span className={cn("text-xs font-medium rounded-full border px-2 py-0.5",
                  c.status === "completed"
                    ? "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-900/60"
                    : "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900/60")}>
                  {c.status === "completed" ? "Completed" : "Active"}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

// ─────────────────────────── Add dialog ───────────────────────────
function AddClientDialog({ userEmails, existingTags, onAdded }: {
  userEmails: string[]; existingTags: string[]; onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [start, setStart] = useState(todayStr());
  const [domains, setDomains] = useState("");
  const [inbox, setInbox] = useState("");
  const [ops, setOps] = useState("");

  function reset() { setName(""); setTag(""); setStart(todayStr()); setDomains(""); setInbox(""); setOps(""); }

  async function submit() {
    const t = tag.trim().toUpperCase();
    if (!t) { toast.error("Client tag is required"); return; }
    if (existingTags.includes(t)) { toast.error(`${t} is already in onboarding`); return; }
    setBusy(true);
    const r = await postMutate({
      action: "add-client", client_tag: t, client_name: name, start_date: start,
      domains_owner_email: domains || null, inbox_owner_email: inbox || null, ops_owner_email: ops || null,
    });
    setBusy(false);
    if (r.ok) { toast.success(`${t} onboarded — ${r.tasks ?? 0} tasks generated`); setOpen(false); reset(); onAdded(); }
    else toast.error(r.error || "Failed to add client");
  }

  const ownerOptions = [UNASSIGNED, ...userEmails];
  const OwnerSelect = ({ role, value, set }: { role: OnboardingRole; value: string; set: (v: string) => void }) => (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{ROLE_META[role].label}</label>
      <Select value={value || UNASSIGNED} onValueChange={(v) => set(v === UNASSIGNED ? "" : v)}>
        <SelectTrigger className="w-full"><SelectValue placeholder="Unassigned" /></SelectTrigger>
        <SelectContent>
          {ownerOptions.map((o) => <SelectItem key={o} value={o}>{o === UNASSIGNED ? "— Unassigned —" : o}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button>Add to Onboarding</Button></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add client to onboarding</DialogTitle>
          <DialogDescription>Generates the standard task timeline from the start date and assigns tasks by role.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Client Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Cleaning Co." />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Client Tag</label>
              <Input value={tag} onChange={(e) => setTag(e.target.value.toUpperCase())} placeholder="ACME" className="font-mono" />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Start Date</label>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="grid grid-cols-1 gap-3">
            <OwnerSelect role="domains" value={domains} set={setDomains} />
            <OwnerSelect role="inbox" value={inbox} set={setInbox} />
            <OwnerSelect role="ops" value={ops} set={setOps} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Adding…" : "Add & generate tasks"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────── Board ───────────────────────────
function Board({ tasks, clients, myEmail, onChange }: {
  tasks: OnbTask[]; clients: OnbClient[]; userEmails: string[]; myEmail: string | null; onChange: () => void;
}) {
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [mineOnly, setMineOnly] = useState(false);
  const activeTags = useMemo(() => new Set(clients.filter((c) => c.status !== "completed").map((c) => c.client_tag)), [clients]);

  const filtered = useMemo(() => tasks.filter((t) => {
    if (clientFilter === "all" ? !activeTags.has(t.client_tag) : t.client_tag !== clientFilter) return false;
    if (mineOnly && t.assignee_email !== myEmail) return false;
    return true;
  }), [tasks, clientFilter, mineOnly, activeTags, myEmail]);

  async function setStatus(id: string, status: TaskStatus) {
    const r = await postMutate({ action: "update-task-status", id, status });
    if (r.ok) { toast.success("Updated"); onChange(); } else toast.error(r.error || "Failed");
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={clientFilter} onValueChange={setClientFilter}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All active clients</SelectItem>
            {clients.map((c) => <SelectItem key={c.client_tag} value={c.client_tag}>{c.client_tag}{c.client_name ? ` · ${c.client_name}` : ""}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant={mineOnly ? "default" : "outline"} size="sm" onClick={() => setMineOnly((v) => !v)}>My tasks only</Button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {TASK_STATUS_ORDER.map((status) => {
          const col = filtered.filter((t) => t.status === status);
          const m = STATUS_META[status];
          return (
            <div key={status} className={cn("rounded-xl border bg-muted/20", m.col)}>
              <div className="flex items-center justify-between px-3 py-2.5 border-b">
                <span className="flex items-center gap-2 text-sm font-medium"><span className={cn("h-2 w-2 rounded-full", m.dot)} />{m.label}</span>
                <span className="text-xs text-muted-foreground tabular-nums rounded-full bg-muted px-2 py-0.5">{col.length}</span>
              </div>
              <div className="p-2 space-y-2 min-h-[80px]">
                {col.length === 0 && <div className="text-xs text-muted-foreground/60 text-center py-6">Nothing here</div>}
                {col.map((t) => (
                  <div key={t.id} className="rounded-lg border bg-card p-3 space-y-2 hover:shadow-sm transition-shadow">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium leading-snug">{t.title}</span>
                      <TagPill tag={t.client_tag} />
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5"><RolePill role={t.role} />{shortEmail(t.assignee_email) || "unassigned"}</span>
                      <span className="tabular-nums">{fmtDate(t.due_date)}</span>
                    </div>
                    <Select value={t.status} onValueChange={(v) => setStatus(t.id, v as TaskStatus)}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TASK_STATUS_ORDER.map((s) => <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────── My Tasks ───────────────────────────
function MyTasks({ tasks, myEmail, onChange }: { tasks: OnbTask[]; myEmail: string | null; onChange: () => void }) {
  const today = todayStr();
  const mine = useMemo(() =>
    tasks.filter((t) => t.assignee_email && t.assignee_email === myEmail && t.status !== "completed")
         .sort((a, b) => (a.due_date || "").localeCompare(b.due_date || "")),
    [tasks, myEmail, today]);

  const groups = useMemo(() => {
    const overdue: OnbTask[] = [], todayT: OnbTask[] = [], upcoming: OnbTask[] = [];
    for (const t of mine) {
      if (!t.due_date) { upcoming.push(t); continue; }
      if (t.due_date < today) overdue.push(t);
      else if (t.due_date === today) todayT.push(t);
      else upcoming.push(t);
    }
    return { overdue, todayT, upcoming };
  }, [mine, today]);

  async function setStatus(id: string, status: TaskStatus) {
    const r = await postMutate({ action: "update-task-status", id, status });
    if (r.ok) { toast.success("Updated"); onChange(); } else toast.error(r.error || "Failed");
  }

  if (!myEmail) return <div className="text-sm text-muted-foreground py-12 text-center">No session.</div>;
  if (!mine.length) {
    return <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">You're all caught up — no open tasks assigned to you. 🎉</CardContent></Card>;
  }

  const Section = ({ label, items, tint }: { label: string; items: OnbTask[]; tint: string }) => items.length ? (
    <div className="space-y-2">
      <h3 className={cn("text-xs font-semibold uppercase tracking-wide", tint)}>{label} · {items.length}</h3>
      <Card className="overflow-hidden"><div className="divide-y">
        {items.map((t) => (
          <div key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{t.title}</div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                <TagPill tag={t.client_tag} /><RolePill role={t.role} /><span className="tabular-nums">{fmtDate(t.due_date)}</span>
              </div>
            </div>
            <Select value={t.status} onValueChange={(v) => setStatus(t.id, v as TaskStatus)}>
              <SelectTrigger className="h-8 w-36 text-xs shrink-0"><SelectValue /></SelectTrigger>
              <SelectContent>{TASK_STATUS_ORDER.map((s) => <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        ))}
      </div></Card>
    </div>
  ) : null;

  return (
    <div className="space-y-5">
      <Section label="Overdue" items={groups.overdue} tint="text-destructive" />
      <Section label="Today" items={groups.todayT} tint="text-blue-600 dark:text-blue-400" />
      <Section label="Upcoming" items={groups.upcoming} tint="text-muted-foreground" />
    </div>
  );
}

// ─────────────────────────── Template editor ───────────────────────────
function TemplateEditor({ template, onChange }: { template: TemplateTask[]; onChange: () => void }) {
  const [busy, setBusy] = useState(false);

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    const r = await postMutate(body);
    setBusy(false);
    if (r.ok) { onChange(); } else toast.error(r.error || "Failed");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">The standard task timeline. Changes apply to clients added afterward.</p>
        {!template.length && <Button size="sm" onClick={() => save({ action: "template-seed" }).then(() => toast.success("Seeded"))} disabled={busy}>Seed defaults</Button>}
      </div>
      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Task</TableHead>
              <TableHead className="w-36">Role</TableHead>
              <TableHead className="w-24">Day offset</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {template.map((t, i) => (
              <TemplateRow key={t.id} task={t} index={i} onSave={save} busy={busy} />
            ))}
            <TemplateRow key="new" task={null} index={template.length} onSave={save} busy={busy} />
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function TemplateRow({ task, index, onSave, busy }: {
  task: TemplateTask | null; index: number; onSave: (b: Record<string, unknown>) => Promise<void>; busy: boolean;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [role, setRole] = useState<OnboardingRole>(task?.role ?? "ops");
  const [day, setDay] = useState<string>(task ? String(task.day_offset) : "");
  const isNew = !task;
  const dirty = !isNew && (title !== task!.title || role !== task!.role || String(task!.day_offset) !== day);

  async function commit() {
    if (!title.trim()) { if (isNew) return; toast.error("Title required"); return; }
    await onSave({ action: "template-upsert", id: task?.id ?? null, title, role, day_offset: Number(day) || 0 });
    if (isNew) { setTitle(""); setRole("ops"); setDay(""); toast.success("Task added"); }
    else toast.success("Saved");
  }

  return (
    <TableRow className={cn(isNew && "bg-muted/20")}>
      <TableCell className="text-xs text-muted-foreground tabular-nums">{isNew ? "+" : index + 1}</TableCell>
      <TableCell>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={isNew ? "Add a task…" : ""} className="h-8" />
      </TableCell>
      <TableCell>
        <Select value={role} onValueChange={(v) => setRole(v as OnboardingRole)}>
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(["domains", "inbox", "ops"] as OnboardingRole[]).map((r) => <SelectItem key={r} value={r}>{ROLE_META[r].label}</SelectItem>)}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Input type="number" value={day} onChange={(e) => setDay(e.target.value)} className="h-8 w-20" placeholder="0" />
      </TableCell>
      <TableCell className="text-right">
        {isNew ? (
          <Button size="sm" variant="ghost" onClick={commit} disabled={busy || !title.trim()}>Add</Button>
        ) : (
          <div className="flex items-center gap-1 justify-end">
            {dirty && <Button size="sm" variant="ghost" onClick={commit} disabled={busy}>Save</Button>}
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => onSave({ action: "template-delete", id: task!.id }).then(() => toast.success("Deleted"))} disabled={busy}>✕</Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
