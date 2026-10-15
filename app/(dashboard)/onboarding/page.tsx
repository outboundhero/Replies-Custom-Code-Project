"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowRight, ChevronDown, ClipboardList, FileSpreadsheet, Loader2, Search, Zap } from "lucide-react";
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
  STATUS_META, TASK_STATUS_ORDER, AUTOMATION_META, GROUP_META, fmtDate, todayStr,
} from "@/lib/onboarding/ui";
import { addDays, groupForStartDate, isValidDate, type TaskStatus } from "@/lib/onboarding/generate";
import { DEFAULT_TEMPLATE } from "@/lib/onboarding/seed";
import {
  type BoardData, type OnbClient, type OnbTask, type UserRow,
  UNASSIGNED, DUE_TONE, postMutate, taskGate, dueInfo, useStatusSetter,
  TagPill, GroupBadge, Progress, StatusSelect, TaskAction, TaskNotes, ClientChecklist, RunDialog,
} from "./_ui/shared";
import { EmailCopyEditor } from "./_ui/email-copy";

type TemplateTask = {
  id: string; title: string; day_offset: number; order_index: number; task_group: string | null;
  assignee_id: string | null; no_due: number; automation: string | null;
};

// Plan / package options (from the client tracker). Kept as a simple list so it's
// easy to edit if the tiers change.
const PLAN_OPTIONS = ["Tier 0.5 (Trial)", "Tier 1 (Base)", "Tier 2 (Scale)", "PPQM", "PPQL"];
/** The sheet's plan text ("Tier 1 (Base) = 20 Outlook Azure Domains") → one of our options. */
function matchPlan(raw: string): string {
  const s = (raw || "").trim();
  if (/tier\s*0\.5/i.test(s)) return PLAN_OPTIONS[0];
  if (/tier\s*1/i.test(s)) return PLAN_OPTIONS[1];
  if (/tier\s*2/i.test(s)) return PLAN_OPTIONS[2];
  if (/ppqm/i.test(s)) return "PPQM";
  if (/ppql/i.test(s)) return "PPQL";
  return s;
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className={cn("text-2xl font-semibold tracking-tight tabular-nums", accent)}>{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

// Stale-while-revalidate cache: keep the last board payload in module scope so
// navigating back to Onboarding paints instantly (no skeleton) while a fresh copy
// loads in the background. Lives for the browser session.
let boardCache: BoardData | null = null;
const EMPTY: BoardData = { clients: [], tasks: [], users: [], outreachifySlack: { saved: null, sendsTo: [] } };

// ─────────────────────────── page ───────────────────────────
// useSearchParams needs a Suspense boundary above it.
export default function OnboardingPage() {
  return <Suspense fallback={null}><OnboardingBoard /></Suspense>;
}

function OnboardingBoard() {
  const session = useSession();
  // ?copy=TAG (from a client's page) opens that client's email copy.
  const openClient = useSearchParams().get("copy")?.trim().toUpperCase() || null;
  const isAdmin = session?.role === "admin";

  const [board, setBoard] = useState<BoardData>(boardCache ?? EMPTY);
  const [loading, setLoading] = useState(!boardCache); // instant paint if cached
  const [err, setErr] = useState<string | null>(null);
  const { clients, tasks, users } = board;

  // One request for everything the page needs (clients + tasks + team).
  // `fresh` (after a write) skips the server's short cache.
  const load = useCallback(async (fresh = false) => {
    try {
      const b = await fetch(fresh ? "/api/onboarding?fresh=1" : "/api/onboarding");
      if (b.status === 401) { window.location.href = "/login"; return; }
      if (!b.ok) { setErr(`Failed to load (${b.status})`); return; }
      const data = await b.json();
      const next: BoardData = {
        clients: data.clients ?? [], tasks: data.tasks ?? [], users: data.users ?? [],
        outreachifySlack: data.outreachifySlack ?? EMPTY.outreachifySlack,
      };
      boardCache = next;
      setBoard(next);
      setErr(null);
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  const reload = useCallback(() => load(true), [load]);

  const today = todayStr();
  const stats = useMemo(() => {
    const activeTags = new Set(clients.filter((c) => c.status !== "completed").map((c) => c.client_tag));
    const open = tasks.filter((t) => activeTags.has(t.client_tag) && t.status !== "completed");
    const week = addDays(today, 7);
    return {
      active: activeTags.size,
      open: open.length,
      overdue: open.filter((t) => t.due_date && t.due_date < today).length,
      soon: open.filter((t) => t.due_date && t.due_date >= today && t.due_date <= week).length,
    };
  }, [clients, tasks, today]);

  const existingTags = useMemo(() => clients.map((c) => c.client_tag), [clients]);
  const [tab, setTab] = useState(openClient ? "copy" : "clients");
  const pickClients = useMemo(() => clients.map((c) => ({ tag: c.client_tag.toUpperCase(), name: c.client_name ?? null })), [clients]);

  return (
    <div className="space-y-6 max-w-7xl mx-auto w-full">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Onboarding</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Every new client gets the same checklist — open a client to run or complete its steps.
          </p>
        </div>
        {isAdmin && <AddClientDialog existingTags={existingTags} onAdded={reload} />}
      </div>

      {err && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{err}</div>}

      {clients.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Clients in onboarding" value={stats.active} />
          <Stat label="Open tasks" value={stats.open} accent="text-blue-600 dark:text-blue-400" />
          <Stat label="Overdue" value={stats.overdue} accent={stats.overdue ? "text-destructive" : undefined} />
          <Stat label="Due in the next 7 days" value={stats.soon} />
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="clients">Clients</TabsTrigger>
          <TabsTrigger value="people">By person</TabsTrigger>
          <TabsTrigger value="board">Board</TabsTrigger>
          {isAdmin && <TabsTrigger value="template">Template</TabsTrigger>}
          {isAdmin && <TabsTrigger value="copy">Email copy</TabsTrigger>}
          {isAdmin && <TabsTrigger value="team">Team</TabsTrigger>}
        </TabsList>

        <TabsContent value="clients" className="mt-4">
          <ClientsList clients={clients} tasks={tasks} users={users} loading={loading} isAdmin={isAdmin}
            existingTags={existingTags} onChanged={reload} />
        </TabsContent>
        <TabsContent value="people" className="mt-4">
          <PeopleView clients={clients} tasks={tasks} users={users} isAdmin={isAdmin}
            myEmail={session?.email ?? null} onChanged={reload} />
        </TabsContent>
        <TabsContent value="board" className="mt-4">
          <Board tasks={tasks} clients={clients} users={users} onChange={reload} />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="template" className="mt-4">
            <TemplateEditor users={users} onUsersChanged={reload} />
          </TabsContent>
        )}
        {isAdmin && (
          // Kept mounted (just hidden) so unsaved copy edits survive switching tabs.
          <TabsContent value="copy" forceMount className="mt-4 data-[state=inactive]:hidden">
            <EmailCopyEditor active={tab === "copy"} clients={pickClients} openClient={openClient} />
          </TabsContent>
        )}
        {isAdmin && (
          <TabsContent value="team" className="mt-4">
            <TeamManager users={users} slack={board.outreachifySlack} onChange={reload} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// ─────────────────────────── Clients (expandable checklists) ───────────────────────────
function StatusChip({ status }: { status: string }) {
  const done = status === "completed";
  return (
    <span className={cn("text-[11px] font-medium rounded-full border px-2 py-0.5 shrink-0",
      done
        ? "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-900/60"
        : "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900/60")}>
      {done ? "Completed" : "Active"}
    </span>
  );
}

/** The step a client is waiting on: its next ordered step, else its next due task. */
function nextUp(clientTasks: OnbTask[], usersById: Map<string, UserRow>): string {
  const open = clientTasks.filter((t) => t.status !== "completed");
  if (!open.length) return clientTasks.length ? "Everything is done" : "No tasks yet";
  const step = open.filter((t) => t.no_due).sort((a, b) => a.order_index - b.order_index)[0];
  const dated = open.filter((t) => !t.no_due && t.due_date).sort((a, b) => (a.due_date || "").localeCompare(b.due_date || ""))[0];
  const t = step ?? dated ?? open[0];
  const owner = t.assignee_email ? usersById.get(t.assignee_email)?.name : null;
  return `Next: ${t.title}${owner ? ` — ${owner}` : ""}${!t.no_due && t.due_date ? `, due ${fmtDate(t.due_date)}` : ""}`;
}

function ClientsList({ clients, tasks, users, loading, isAdmin, existingTags, onChanged }: {
  clients: OnbClient[]; tasks: OnbTask[]; users: UserRow[]; loading: boolean; isAdmin: boolean;
  existingTags: string[]; onChanged: () => void;
}) {
  const [openTags, setOpenTags] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const tasksByClient = useMemo(() => {
    const m = new Map<string, OnbTask[]>();
    for (const t of tasks) { const arr = m.get(t.client_tag); if (arr) arr.push(t); else m.set(t.client_tag, [t]); }
    return m;
  }, [tasks]);

  const completedCount = clients.filter((c) => c.status === "completed").length;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return clients.filter((c) =>
      (showCompleted || c.status !== "completed") &&
      (!needle || c.client_tag.toLowerCase().includes(needle) || (c.client_name || "").toLowerCase().includes(needle)));
  }, [clients, q, showCompleted]);

  const toggle = (tag: string) => setOpenTags((prev) => {
    const n = new Set(prev); if (n.has(tag)) n.delete(tag); else n.add(tag); return n;
  });

  if (loading) {
    return <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-[4.5rem] rounded-xl border bg-muted/30 animate-pulse" />)}</div>;
  }
  if (!clients.length) {
    return (
      <Card>
        <CardContent className="py-20 flex flex-col items-center text-center gap-3">
          <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
            <ClipboardList className="h-6 w-6 text-muted-foreground" />
          </div>
          <div className="space-y-1 max-w-sm">
            <h3 className="text-base font-semibold">No clients in onboarding yet</h3>
            <p className="text-sm text-muted-foreground">Add a client and it gets the standard checklist — the setup steps that run in order, plus the dated follow-ups.</p>
          </div>
          {isAdmin && <div className="pt-1"><AddClientDialog existingTags={existingTags} onAdded={onChanged} /></div>}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a client tag or name" className="h-9 pl-8" />
        </div>
        {completedCount > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
            <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-muted-foreground/40 accent-primary" />
            Show completed clients ({completedCount})
          </label>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{shown.length} client{shown.length === 1 ? "" : "s"}</span>
      </div>

      {!shown.length && (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">
          {q.trim() ? <>No client matches “{q.trim()}”.</> : "Every client has finished onboarding — tick “Show completed clients” to see them."}
        </CardContent></Card>
      )}

      {shown.map((c) => {
        const open = openTags.has(c.client_tag);
        const clientTasks = tasksByClient.get(c.client_tag) ?? [];
        return (
          <Card key={c.client_tag} className={cn("gap-0 overflow-hidden p-0 transition-shadow", open && "shadow-sm border-primary/30")}>
            <div className="flex items-stretch">
              <button type="button" onClick={() => toggle(c.client_tag)} aria-expanded={open}
                className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 text-left hover:bg-muted/30 transition-colors">
                <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
                <div className="min-w-0 flex-1 basis-64">
                  <div className="flex flex-wrap items-center gap-2">
                    <TagPill tag={c.client_tag} />
                    {c.client_name && <span className="truncate text-sm font-medium">{c.client_name}</span>}
                    {c.plan_type && <span className="text-[10px] font-medium rounded-full border border-border bg-muted px-1.5 py-0.5 text-muted-foreground">{c.plan_type}</span>}
                    <GroupBadge group={c.group_num} />
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    Started {fmtDate(c.start_date)} · {nextUp(clientTasks, usersById)}
                  </div>
                </div>
                <Progress done={c.tasks_done} total={c.tasks_total} className="w-full sm:w-52" />
                <StatusChip status={c.status} />
              </button>
              <Link href={`/onboarding/${encodeURIComponent(c.client_tag)}`} title="Open the client page"
                className="flex items-center border-l px-3 text-muted-foreground hover:bg-muted/40 hover:text-primary transition-colors">
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
            {open && (
              <div className="border-t bg-muted/10 px-4 py-4">
                <ClientChecklist client={c} tasks={clientTasks} users={users} isAdmin={isAdmin} onChanged={onChanged} />
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ─────────────────────────── Add dialog ───────────────────────────
function AddClientDialog({ existingTags, onAdded }: { existingTags: string[]; onAdded: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [looking, setLooking] = useState(false);
  const [sheetNote, setSheetNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [plan, setPlan] = useState("");
  const [start, setStart] = useState(todayStr());
  const [groupSel, setGroupSel] = useState<"auto" | "1" | "2">("auto");

  function reset() { setName(""); setTag(""); setPlan(""); setStart(todayStr()); setGroupSel("auto"); setSheetNote(null); }

  const ruleGroup = groupForStartDate(start);
  const planOptions = !plan || PLAN_OPTIONS.includes(plan) ? PLAN_OPTIONS : [...PLAN_OPTIONS, plan];

  async function fillFromSheet() {
    const t = tag.trim().toUpperCase();
    if (!t) { toast.error("Enter the client tag first"); return; }
    setLooking(true);
    try {
      const res = await fetch(`/api/onboarding/lookup?tag=${encodeURIComponent(t)}`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setSheetNote({ ok: false, text: d.error || `Couldn't read the sheet (${res.status})` }); return; }
      if (!d.found) { setSheetNote({ ok: false, text: `${t} isn't in the sheet's “New Client Information” tab yet — fill the details in by hand.` }); return; }
      if (d.client_name) setName(d.client_name);
      if (d.plan) setPlan(matchPlan(d.plan));
      if (d.start_date) setStart(d.start_date);
      setSheetNote({ ok: true, text: d.start_date ? "Filled in from the onboarding sheet — check it before adding." : "Filled in from the onboarding sheet. It has no start date for this client, so set that here." });
    } finally { setLooking(false); }
  }

  async function submit() {
    const t = tag.trim().toUpperCase();
    if (!t) { toast.error("Client tag is required"); return; }
    if (existingTags.includes(t)) { toast.error(`${t} is already in onboarding`); return; }
    if (!isValidDate(start)) { toast.error("Pick a start date"); return; }
    setBusy(true);
    const r = await postMutate({
      action: "add-client", client_tag: t, client_name: name, plan_type: plan || null, start_date: start,
      group_num: groupSel === "auto" ? null : Number(groupSel),
    });
    setBusy(false);
    if (r.ok) {
      toast.success(`${t} added — ${r.tasks ?? 0} tasks created. Opening its guided onboarding…`);
      setOpen(false); reset(); onAdded();
      router.push(`/onboarding/${encodeURIComponent(t)}/run`);
    }
    else toast.error(r.error || "Failed to add client");
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button className="gap-1.5"><Zap className="h-4 w-4" /> Onboard a client</Button></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add client to onboarding</DialogTitle>
          <DialogDescription>Creates the client&apos;s checklist from the template. Due dates count from the start date — Day 1 is the day after it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Client Tag</label>
            <div className="flex gap-2">
              <Input value={tag} onChange={(e) => { setTag(e.target.value.toUpperCase()); setSheetNote(null); }} placeholder="ACME" className="font-mono" />
              <Button type="button" variant="outline" className="shrink-0 gap-1.5" onClick={fillFromSheet} disabled={looking || !tag.trim()}>
                {looking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
                Fill from sheet
              </Button>
            </div>
            {sheetNote && <p className={cn("text-[11px]", sheetNote.ok ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400")}>{sheetNote.text}</p>}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Client Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Cleaning Co." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Start Date</label>
              <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Plan / Package <span className="opacity-60">(optional)</span></label>
              <Select value={plan || UNASSIGNED} onValueChange={(v) => setPlan(v === UNASSIGNED ? "" : v)}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select a plan" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED}>— None —</SelectItem>
                  {planOptions.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Group</label>
            <Select value={groupSel} onValueChange={(v) => setGroupSel(v as "auto" | "1" | "2")}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">By start date{ruleGroup ? ` — Group ${ruleGroup}` : " — none yet"}</SelectItem>
                {([1, 2] as const).map((g) => (
                  <SelectItem key={g} value={String(g)}>{GROUP_META[g].label} — {GROUP_META[g].b2b} + {GROUP_META[g].b2c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {groupSel !== "auto"
                ? "You can still change the group when you run the Slack step."
                : ruleGroup
                  ? `Clients starting on the ${ruleGroup === 2 ? "1st" : "15th"} go to Group ${ruleGroup}.`
                  : "Clients starting on the 1st go to Group 2 and on the 15th to Group 1. This date is neither, so pick the group here or when you run the Slack step."}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Adding…" : "Add & start onboarding"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────── By person ───────────────────────────
/** One person's tasks across every active client: client tag, task, due date, status. */
function PeopleView({ clients, tasks, users, isAdmin, myEmail, onChanged }: {
  clients: OnbClient[]; tasks: OnbTask[]; users: UserRow[]; isAdmin: boolean; myEmail: string | null; onChanged: () => void;
}) {
  const today = todayStr();
  const clientsByTag = useMemo(() => new Map(clients.map((c) => [c.client_tag, c])), [clients]);
  const activeTags = useMemo(() => new Set(clients.filter((c) => c.status !== "completed").map((c) => c.client_tag)), [clients]);
  const tasksByClient = useMemo(() => {
    const m = new Map<string, OnbTask[]>();
    for (const t of tasks) { const arr = m.get(t.client_tag); if (arr) arr.push(t); else m.set(t.client_tag, [t]); }
    return m;
  }, [tasks]);

  // People who own tasks on an active client, in checklist order (Nick → Madison → Spencer).
  const people = useMemo(() => {
    const info = new Map<string, { open: number; first: number }>();
    for (const t of tasks) {
      if (!t.assignee_email || !activeTags.has(t.client_tag)) continue;
      const cur = info.get(t.assignee_email) ?? { open: 0, first: Infinity };
      if (t.status !== "completed") cur.open++;
      cur.first = Math.min(cur.first, t.order_index);
      info.set(t.assignee_email, cur);
    }
    return users.filter((u) => info.has(u.id))
      .map((u) => ({ ...u, ...info.get(u.id)! }))
      .sort((a, b) => a.first - b.first || a.name.localeCompare(b.name));
  }, [tasks, users, activeTags]);

  // Whose tasks open first: the person linked to this login (Team → login
  // email), else the one whose first name starts the login's address.
  const login = (myEmail || "").toLowerCase();
  const mine = login
    ? people.find((p) => p.email === login) ?? people.find((p) => login.split("@")[0].startsWith(p.name.trim().split(/\s+/)[0].toLowerCase()))
    : undefined;
  const [picked, setPicked] = useState<string | null>(null);
  const personId = (picked && people.some((p) => p.id === picked) ? picked : null) ?? mine?.id ?? people[0]?.id ?? null;
  const [showDone, setShowDone] = useState(false);
  const { busyId, setStatus } = useStatusSetter(onChanged);
  const [runTask, setRunTask] = useState<OnbTask | null>(null);

  const rows = useMemo(() => {
    if (!personId) return [];
    return tasks
      .filter((t) => t.assignee_email === personId && activeTags.has(t.client_tag) && (showDone || t.status !== "completed"))
      .map((t) => ({ task: t, gate: taskGate(t, tasksByClient.get(t.client_tag) ?? []) }))
      // Ready steps first, then by due date, then the steps still waiting their turn.
      .sort((a, b) => {
        const rank = (x: typeof a) => (x.task.status === "completed" ? 3 : !x.task.no_due ? 1 : x.gate.blocker ? 2 : 0);
        return rank(a) - rank(b)
          || (a.task.due_date || "9999").localeCompare(b.task.due_date || "9999")
          || a.task.client_tag.localeCompare(b.task.client_tag)
          || a.task.order_index - b.task.order_index;
      });
  }, [tasks, personId, activeTags, showDone, tasksByClient]);

  if (!people.length) {
    return (
      <Card><CardContent className="py-16 text-center text-sm text-muted-foreground">
        Nobody has onboarding tasks yet — add a client and each person&apos;s tasks show up here.
      </CardContent></Card>
    );
  }

  const person = people.find((p) => p.id === personId);
  const overdue = rows.filter((r) => r.task.status !== "completed" && r.task.due_date && r.task.due_date < today).length;
  const runClient = runTask ? clientsByTag.get(runTask.client_tag) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {people.map((p) => (
          <button key={p.id} type="button" onClick={() => setPicked(p.id)}
            className={cn("flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-sm transition-colors",
              p.id === personId ? "border-primary bg-primary/5 text-foreground" : "text-muted-foreground hover:border-primary/40 hover:text-foreground")}>
            <span className={cn("flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold",
              p.id === personId ? "bg-primary text-primary-foreground" : "bg-muted")}>{p.name.charAt(0).toUpperCase()}</span>
            <span className="font-medium">{p.name}</span>
            <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums">{p.open}</span>
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-muted-foreground/40 accent-primary" />
          Show done
        </label>
      </div>

      <div className="text-xs text-muted-foreground">
        {person?.name}: {person?.open ?? 0} open task{person?.open === 1 ? "" : "s"}
        {overdue > 0 && <span className="text-destructive font-medium"> · {overdue} overdue</span>}
      </div>

      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-44">Client tag</TableHead>
              <TableHead>Task</TableHead>
              <TableHead className="w-40">Due date</TableHead>
              <TableHead className="w-32">Status</TableHead>
              <TableHead className="w-36 text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {!rows.length && (
              <TableRow><TableCell colSpan={5} className="py-12 text-center text-sm text-muted-foreground">
                {showDone ? "No tasks." : `Nothing open for ${person?.name ?? "this person"} — all caught up.`}
              </TableCell></TableRow>
            )}
            {rows.map(({ task: t, gate }) => {
              const due = dueInfo(t, gate, today);
              const c = clientsByTag.get(t.client_tag);
              const busy = busyId === t.id;
              return (
                <TableRow key={t.id} className={cn(gate.blocker && "bg-muted/20")}>
                  <TableCell className="align-top">
                    <Link href={`/onboarding/${encodeURIComponent(t.client_tag)}`} className="group inline-flex flex-col gap-0.5">
                      <span><TagPill tag={t.client_tag} /></span>
                      {c?.client_name && <span className="max-w-40 truncate text-[11px] text-muted-foreground group-hover:text-primary">{c.client_name}</span>}
                    </Link>
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <div className={cn("text-sm font-medium leading-snug", t.status === "completed" && "text-muted-foreground line-through decoration-muted-foreground/40", gate.blocker && "text-muted-foreground")}>{t.title}</div>
                    <TaskNotes task={t} />
                  </TableCell>
                  <TableCell className={cn("align-top text-xs tabular-nums", DUE_TONE[due.tone])}>
                    {t.no_due ? "No due date" : due.text}
                    {t.no_due
                      ? <div className="font-normal text-muted-foreground">{due.text}</div>
                      : t.template_task_id && <div className="font-normal text-muted-foreground">Day {t.day_offset}</div>}
                  </TableCell>
                  <TableCell className="align-top">
                    <StatusSelect task={t} gate={gate} busy={busy} onSet={(v) => setStatus(t.id, v)} />
                  </TableCell>
                  <TableCell className="align-top text-right">
                    <div className="flex justify-end">
                      <TaskAction task={t} gate={gate} isAdmin={isAdmin} busy={busy}
                        onRun={() => setRunTask(t)} onComplete={() => setStatus(t.id, "completed")} />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {runTask && (
        <RunDialog task={runTask} clientLabel={runClient?.client_name ? `${runTask.client_tag} · ${runClient.client_name}` : runTask.client_tag}
          onClose={() => setRunTask(null)} onDone={onChanged} />
      )}
    </div>
  );
}

// ─────────────────────────── Board ───────────────────────────
function Board({ tasks, clients, users, onChange }: {
  tasks: OnbTask[]; clients: OnbClient[]; users: UserRow[]; onChange: () => void;
}) {
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u.name])), [users]);
  const activeTags = useMemo(() => new Set(clients.filter((c) => c.status !== "completed").map((c) => c.client_tag)), [clients]);
  const tasksByClient = useMemo(() => {
    const m = new Map<string, OnbTask[]>();
    for (const t of tasks) { const arr = m.get(t.client_tag); if (arr) arr.push(t); else m.set(t.client_tag, [t]); }
    return m;
  }, [tasks]);

  const filtered = useMemo(() => {
    const rows = tasks.filter((t) => {
      if (clientFilter === "all" ? !activeTags.has(t.client_tag) : t.client_tag !== clientFilter) return false;
      if (ownerFilter !== "all" && t.assignee_email !== ownerFilter) return false;
      return true;
    });
    // Ordered steps (no due date) first in checklist order, then by due date.
    return rows.sort((a, b) =>
      (a.no_due ? 0 : 1) - (b.no_due ? 0 : 1)
      || (a.due_date || "").localeCompare(b.due_date || "")
      || a.client_tag.localeCompare(b.client_tag)
      || a.order_index - b.order_index);
  }, [tasks, clientFilter, ownerFilter, activeTags]);

  // Optimistic status: reflect a move instantly; it only counts for the task
  // list it was made against, so it drops away when fresh data lands.
  const [local, setLocal] = useState<{ base: OnbTask[]; map: Record<string, TaskStatus> }>({ base: tasks, map: {} });
  const localStatus = local.base === tasks ? local.map : {};
  const effStatus = (t: OnbTask): TaskStatus => localStatus[t.id] ?? t.status;

  // Native HTML5 drag-and-drop between columns.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<TaskStatus | null>(null);

  async function setStatus(id: string, status: TaskStatus) {
    setLocal((prev) => ({ base: tasks, map: { ...(prev.base === tasks ? prev.map : {}), [id]: status } })); // optimistic
    const r = await postMutate({ action: "update-task-status", id, status });
    if (r.ok) { onChange(); }
    else { toast.error(r.error || "Failed"); setLocal((prev) => { const map = { ...prev.map }; delete map[id]; return { ...prev, map }; }); }
  }
  function dropOnStatus(status: TaskStatus) {
    const id = dragId;
    setOverStatus(null); setDragId(null);
    if (id) { const t = tasks.find((x) => x.id === id); if (t && effStatus(t) !== status) setStatus(id, status); }
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
        <Select value={ownerFilter} onValueChange={setOwnerFilter}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Everyone" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone</SelectItem>
            {users.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">Drag a card to change its status. Steps that run in order can&apos;t skip ahead.</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 h-[calc(100vh-16rem)] min-h-[340px]">
        {TASK_STATUS_ORDER.map((status) => {
          const col = filtered.filter((t) => effStatus(t) === status);
          const m = STATUS_META[status];
          const isOver = overStatus === status;
          return (
            <div key={status}
              onDragOver={(e) => { e.preventDefault(); if (overStatus !== status) setOverStatus(status); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverStatus((s) => (s === status ? null : s)); }}
              onDrop={(e) => { e.preventDefault(); dropOnStatus(status); }}
              className={cn("flex flex-col rounded-xl border bg-muted/20 overflow-hidden transition-colors", m.col, isOver && "ring-2 ring-primary/50 bg-primary/5")}>
              <div className="flex items-center justify-between px-3 py-2.5 border-b shrink-0">
                <span className="flex items-center gap-2 text-sm font-medium"><span className={cn("h-2 w-2 rounded-full", m.dot)} />{m.label}</span>
                <span className="text-xs text-muted-foreground tabular-nums rounded-full bg-muted px-2 py-0.5">{col.length}</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {col.length === 0 && <div className="text-xs text-muted-foreground/60 text-center py-10">{isOver ? "Drop here" : "Nothing here"}</div>}
                {col.map((t) => {
                  const gate = taskGate(t, tasksByClient.get(t.client_tag) ?? []);
                  return (
                    <div key={t.id} draggable
                      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", t.id); setDragId(t.id); }}
                      onDragEnd={() => { setDragId(null); setOverStatus(null); }}
                      className={cn("rounded-lg border bg-card p-3 space-y-2 cursor-grab active:cursor-grabbing hover:shadow-sm transition-all", dragId === t.id && "opacity-40")}>
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-medium leading-snug">{t.title}</span>
                        <TagPill tag={t.client_tag} />
                      </div>
                      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{(t.assignee_email && usersById.get(t.assignee_email)) || "Unassigned"}</span>
                        <span className="tabular-nums shrink-0">
                          {t.no_due ? `Step ${gate.step ?? "–"} of ${gate.total}` : `${fmtDate(t.due_date)}${t.template_task_id ? ` · D${t.day_offset}` : ""}`}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────── Template editor ───────────────────────────
// Self-fetching: only mounts (and hits the API) when the Template tab is opened —
// keeps it off the page's initial load. Cached in module scope for instant re-open.
let templateCache: TemplateTask[] | null = null;
function TemplateEditor({ users, onUsersChanged }: { users: UserRow[]; onUsersChanged: () => void }) {
  const [template, setTemplate] = useState<TemplateTask[]>(templateCache ?? []);
  const [loaded, setLoaded] = useState(!!templateCache);
  const [busy, setBusy] = useState(false);

  const fetchTemplate = useCallback(async (fresh = false): Promise<TemplateTask[] | null> => {
    const r = await fetch(fresh ? "/api/onboarding/template?fresh=1" : "/api/onboarding/template");
    return r.ok ? ((await r.json()) as TemplateTask[]) : null;
  }, []);
  const showTemplate = useCallback((t: TemplateTask[] | null) => {
    if (t) { templateCache = t; setTemplate(t); setLoaded(true); }
  }, []);
  useEffect(() => {
    let alive = true;
    fetchTemplate().then((t) => { if (alive) showTemplate(t); });
    return () => { alive = false; };
  }, [fetchTemplate, showTemplate]);
  const loadTemplate = async () => showTemplate(await fetchTemplate(true)); // after a save

  async function save(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    const r = await postMutate(body);
    setBusy(false);
    if (r.ok) { await loadTemplate(); return true; }
    toast.error(r.error || "Failed");
    return false;
  }

  const isStandard = template.length === DEFAULT_TEMPLATE.length && DEFAULT_TEMPLATE.every((s, i) => template[i]?.title === s.title);
  const owners = (name: string) => DEFAULT_TEMPLATE.filter((t) => t.owner === name).length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        The checklist every new client gets. Changes apply to clients added afterwards — clients already in onboarding keep their tasks.
      </p>

      {loaded && !isStandard && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
          <div className="min-w-0 flex-1 basis-72">
            <div className="text-sm font-medium">This isn&apos;t the standard checklist</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              The standard one has {DEFAULT_TEMPLATE.length} tasks — Nick {owners("Nick")} (in order, no due dates), Madison {owners("Madison")} and Spencer {owners("Spencer")} (due by day).
            </div>
          </div>
          <ApplyStandardDialog current={template.length} onApplied={async () => { await loadTemplate(); onUsersChanged(); }} />
        </div>
      )}

      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Task</TableHead>
              <TableHead className="w-40">Owner</TableHead>
              <TableHead className="w-56">Due</TableHead>
              <TableHead className="w-40">Type</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {template.map((t, i) => (
              <TemplateRow key={`${t.id}:${t.title}:${t.assignee_id}:${t.no_due}:${t.day_offset}`} task={t} index={i} users={users} onSave={save} busy={busy} />
            ))}
            <TemplateRow key={`new:${template.length}`} task={null} index={template.length} users={users} onSave={save} busy={busy} />
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function ApplyStandardDialog({ current, onApplied }: { current: number; onApplied: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function apply() {
    setBusy(true);
    const r = await postMutate({ action: "template-apply-standard" });
    if (r.ok) {
      await onApplied();
      toast.success(`Standard checklist is now the template — ${r.inserted ?? DEFAULT_TEMPLATE.length} tasks`);
      setOpen(false);
    } else toast.error(r.error || "Couldn't replace the template");
    setBusy(false);
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
      <DialogTrigger asChild><Button size="sm">Use the standard checklist</Button></DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Replace the template with the standard checklist?</DialogTitle>
          <DialogDescription>
            The {current} task{current === 1 ? "" : "s"} in the template now {current === 1 ? "is" : "are"} replaced by the {DEFAULT_TEMPLATE.length} standard ones.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Only clients added from now on get the new checklist.</li>
          <li>Clients already in onboarding keep the tasks they have.</li>
          <li>The template being replaced is saved as a backup, so it can be restored.</li>
          <li>Nick, Madison and Spencer are added to the team if they aren&apos;t there yet.</li>
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button onClick={apply} disabled={busy}>{busy ? "Replacing…" : "Replace template"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TemplateRow({ task, index, users, onSave, busy }: {
  task: TemplateTask | null; index: number; users: UserRow[];
  onSave: (b: Record<string, unknown>) => Promise<boolean>; busy: boolean;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [owner, setOwner] = useState(task?.assignee_id ?? "");
  const [inOrder, setInOrder] = useState(!!task?.no_due);
  const [day, setDay] = useState<string>(task && !task.no_due ? String(task.day_offset) : "");
  const isNew = !task;
  const dirty = !isNew && (
    title !== task.title || owner !== (task.assignee_id ?? "") || inOrder !== !!task.no_due
    || (!inOrder && String(task.no_due ? "" : task.day_offset) !== day));
  const auto = task?.automation ? AUTOMATION_META[task.automation] : null;

  async function commit() {
    if (!title.trim()) { if (isNew) return; toast.error("Title required"); return; }
    if (!inOrder && day.trim() === "") { toast.error("Enter the day it's due, or choose “In order”"); return; }
    const ok = await onSave({
      action: "template-upsert", id: task?.id ?? null, title, assignee_id: owner || null,
      day_offset: inOrder ? null : Number(day) || 0,
    });
    if (ok) toast.success(isNew ? "Task added" : "Saved");
  }

  return (
    <TableRow className={cn(isNew && "bg-muted/20")}>
      <TableCell className="text-xs text-muted-foreground tabular-nums">{isNew ? "+" : index + 1}</TableCell>
      <TableCell>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={isNew ? "Add a task…" : ""} title={title} className="h-8" />
      </TableCell>
      <TableCell>
        <Select value={owner || UNASSIGNED} onValueChange={(v) => setOwner(v === UNASSIGNED ? "" : v)}>
          <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={UNASSIGNED}>— Unassigned —</SelectItem>
            {users.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Select value={inOrder ? "order" : "day"} onValueChange={(v) => setInOrder(v === "order")}>
            <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="day">On day</SelectItem>
              <SelectItem value="order">In order</SelectItem>
            </SelectContent>
          </Select>
          {inOrder
            ? <span className="text-[11px] text-muted-foreground">no due date</span>
            : <Input type="number" min={0} value={day} onChange={(e) => setDay(e.target.value)} className="h-8 w-20" placeholder="0" />}
        </div>
      </TableCell>
      <TableCell>
        {isNew ? null : auto ? (
          <span title={auto.label} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            auto.built
              ? "border-primary/30 bg-primary/5 text-primary"
              : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300")}>
            <Zap className="h-3 w-3" />{auto.built ? "Automated" : "Automation coming"}
          </span>
        ) : <span className="text-[11px] text-muted-foreground">Manual check-off</span>}
      </TableCell>
      <TableCell className="text-right">
        {isNew ? (
          <Button size="sm" variant="ghost" onClick={commit} disabled={busy || !title.trim()}>Add</Button>
        ) : (
          <div className="flex items-center gap-1 justify-end">
            {dirty && <Button size="sm" variant="ghost" onClick={commit} disabled={busy}>Save</Button>}
            <Button size="sm" variant="ghost" className="text-destructive" title="Remove from the template"
              onClick={async () => { if (await onSave({ action: "template-delete", id: task.id })) toast.success("Removed from the template"); }} disabled={busy}>✕</Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

// ─────────────────────────── Team ───────────────────────────
function TeamManager({ users, slack, onChange }: {
  users: UserRow[]; slack: BoardData["outreachifySlack"]; onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function save(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    const r = await postMutate(body);
    setBusy(false);
    if (r.ok) { onChange(); return true; }
    toast.error(r.error || "Failed");
    return false;
  }
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-3 lg:col-span-2">
        <p className="text-sm text-muted-foreground">
          The people who own checklist tasks. A <span className="font-medium text-foreground">Slack member ID</span> lets them get their task
          messages and the daily digest (Slack → profile → <span className="italic">More</span> → <span className="italic">Copy member ID</span>).
          A <span className="font-medium text-foreground">login email</span> opens “By person” on their own tasks.
        </p>
        <Card className="overflow-hidden p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-44">Slack member ID</TableHead>
                <TableHead className="w-60">Login email</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => <UserEditRow key={`${u.id}:${u.name}:${u.slack_member_id}:${u.email}`} user={u} onSave={save} busy={busy} />)}
              <UserEditRow key={`new:${users.length}`} user={null} onSave={save} busy={busy} />
            </TableBody>
          </Table>
        </Card>
      </div>
      <div className="space-y-6">
        <SlackDestinationCard key={slack.saved ?? ""} slack={slack} onSave={save} busy={busy} />
      </div>
    </div>
  );
}

/** Where step 1 ("Slack Outreachify to onboard new clients") posts. */
function SlackDestinationCard({ slack, onSave, busy }: {
  slack: BoardData["outreachifySlack"]; onSave: (b: Record<string, unknown>) => Promise<boolean>; busy: boolean;
}) {
  const [value, setValue] = useState(slack.saved ?? "");
  const dirty = value.trim() !== (slack.saved ?? "");
  return (
    <Card className="h-fit gap-0 p-0">
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold"><Zap className="h-3.5 w-3.5 text-primary" /> Where “Slack Outreachify” posts</div>
        <p className="mt-1 text-xs text-muted-foreground">Step 1 of every checklist sends the client tag and its group here.</p>
      </div>
      <div className="space-y-3 px-4 py-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Slack channel or member IDs</label>
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="C0123ABCD, U0456EFGH" className="font-mono text-xs" />
          <p className="text-[11px] text-muted-foreground">
            Separate several with commas. A channel ID starts with C (the Reply Router bot has to be in that channel); a member ID starts with U and gets a direct message.
          </p>
        </div>
        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs">
          <div className="font-medium text-muted-foreground">Sends to now</div>
          <div className={cn("mt-0.5", !slack.sendsTo.length && "text-amber-700 dark:text-amber-400")}>
            {slack.sendsTo.length ? slack.sendsTo.join(", ") : "Nobody yet — the step can't run until this is set."}
          </div>
          {slack.saved == null && (
            <div className="mt-1 text-muted-foreground">Nothing saved here, so it goes to team members whose name includes “Outreachify” and who have a Slack member ID.</div>
          )}
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={busy || !dirty}
            onClick={async () => { if (await onSave({ action: "setting-set", key: "outreachify_slack", value })) toast.success("Slack destination saved"); }}>
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}

function UserEditRow({ user, onSave, busy }: {
  user: UserRow | null; onSave: (b: Record<string, unknown>) => Promise<boolean>; busy: boolean;
}) {
  const [name, setName] = useState(user?.name ?? "");
  const [slack, setSlack] = useState(user?.slack_member_id ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const isNew = !user;
  const dirty = !isNew && (name !== user.name || slack.trim() !== (user.slack_member_id ?? "") || email.trim().toLowerCase() !== (user.email ?? ""));

  async function commit() {
    if (!name.trim()) { if (isNew) return; toast.error("Name required"); return; }
    const ok = await onSave({ action: "user-upsert", id: user?.id ?? null, name, slack_member_id: slack.trim() || null, email: email.trim() || null });
    if (ok) toast.success(isNew ? "Team member added" : "Saved");
  }

  return (
    <TableRow className={cn(isNew && "bg-muted/20")}>
      <TableCell>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={isNew ? "Add a team member…" : ""} className="h-8" />
      </TableCell>
      <TableCell>
        <Input value={slack} onChange={(e) => setSlack(e.target.value)} placeholder="U0123ABCD" className="h-8 font-mono text-xs" />
      </TableCell>
      <TableCell>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@outboundhero.co" className="h-8 text-xs" />
      </TableCell>
      <TableCell className="text-right">
        {isNew ? (
          <Button size="sm" variant="ghost" onClick={commit} disabled={busy || !name.trim()}>Add</Button>
        ) : (
          <div className="flex items-center gap-1 justify-end">
            {dirty && <Button size="sm" variant="ghost" onClick={commit} disabled={busy}>Save</Button>}
            <Button size="sm" variant="ghost" className="text-destructive" title="Remove from the team"
              onClick={async () => { if (await onSave({ action: "user-delete", id: user.id })) toast.success("Removed"); }} disabled={busy}>✕</Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
