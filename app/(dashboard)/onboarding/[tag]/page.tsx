"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/components/session-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger, DialogDescription,
} from "@/components/ui/dialog";
import { GROUP_META, fmtDate, groupText } from "@/lib/onboarding/ui";
import { CAMPAIGN_TIMEZONES, timezoneLabel } from "@/lib/onboarding/campaign-plan";
import { clientTypeLabel, type ClientTypeKey } from "@/lib/onboarding/copy-model";
import {
  type OnbClient, type OnbTask, type UserRow,
  UNASSIGNED, postMutate, TagPill, ClientChecklist,
} from "../_ui/shared";

const NO_GROUP = "none";
const NO_TZ = "none";

export default function ClientDetailPage() {
  const params = useParams();
  const session = useSession();
  const isAdmin = session?.role === "admin";
  const tag = decodeURIComponent(String(params.tag || "")).toUpperCase();

  const [client, setClient] = useState<OnbClient | null>(null);
  const [tasks, setTasks] = useState<OnbTask[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async (fresh = false) => {
    try {
      // One request — includes the team. `fresh` (after a write) skips the server's short cache.
      const b = await fetch(fresh ? "/api/onboarding?fresh=1" : "/api/onboarding");
      if (b.status === 401) { window.location.href = "/login"; return; }
      if (!b.ok) { setFailed(b.status === 403 ? "Onboarding is for admins." : `Couldn't load onboarding (${b.status}). Reload to try again.`); return; }
      const data = await b.json();
      const c = (data.clients as OnbClient[]).find((x) => x.client_tag.toUpperCase() === tag) || null;
      setClient(c); setNotFound(!c); setFailed(null);
      setTasks((data.tasks as OnbTask[]).filter((t) => t.client_tag.toUpperCase() === tag));
      setUsers((data.users as UserRow[]) ?? []);
    } catch (e) { setFailed(`Couldn't load onboarding (${(e as Error).message}). Reload to try again.`); }
    finally { setLoading(false); }
  }, [tag]);

  useEffect(() => { load(); }, [load]);
  const reload = useCallback(() => load(true), [load]);

  // A time-zone suggestion from the office on the onboarding sheet (admins only; best effort).
  const [suggestion, setSuggestion] = useState<{ tz: string | null; from: string | null } | null>(null);
  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    fetch(`/api/onboarding/lookup?tag=${encodeURIComponent(tag)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d?.found) setSuggestion({ tz: d.suggested_timezone ?? null, from: d.suggested_from ?? null }); })
      .catch(() => {});
    return () => { live = false; };
  }, [tag, isAdmin]);

  const done = tasks.filter((t) => t.status === "completed").length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  async function refresh(body: Record<string, unknown>, okMsg?: string) {
    const r = await postMutate(body);
    if (r.ok) { if (okMsg) toast.success(okMsg); reload(); } else toast.error(r.error || "Failed");
  }

  if (loading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading…</div>;
  // A load that failed says so — it must never read as "this client isn't in onboarding".
  if (failed && !client) {
    return (
      <div className="space-y-4 max-w-2xl mx-auto w-full">
        <Link href="/onboarding" className="text-sm text-muted-foreground hover:underline">← Onboarding</Link>
        <Card><CardContent className="py-12 text-center text-sm text-destructive">{failed}</CardContent></Card>
      </div>
    );
  }
  if (notFound || !client) {
    return (
      <div className="space-y-4 max-w-2xl mx-auto w-full">
        <Link href="/onboarding" className="text-sm text-muted-foreground hover:underline">← Onboarding</Link>
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">
          <span className="font-mono font-bold">{tag}</span> isn&apos;t in onboarding.
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto w-full">
      <Link href="/onboarding" className="text-sm text-muted-foreground hover:underline">← Onboarding</Link>

      {/* Header */}
      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <TagPill tag={client.client_tag} />
              <div>
                <h2 className="text-xl font-semibold tracking-tight leading-none flex items-center gap-2">
                  {client.client_name || client.client_tag}
                  {client.plan_type && <span className="text-[10px] font-medium rounded-full border border-border bg-muted px-1.5 py-0.5 text-muted-foreground">{client.plan_type}</span>}
                </h2>
                <p className="text-xs text-muted-foreground mt-1">Started {fmtDate(client.start_date)} · Day 1 is the day after</p>
              </div>
            </div>
            {isAdmin && (
              <div className="flex items-center gap-2">
                <Button asChild className="gap-1.5">
                  <Link href={`/onboarding/${encodeURIComponent(client.client_tag)}/run`}><Sparkles className="h-4 w-4" /> Guided onboarding</Link>
                </Button>
                <StartDateDialog tag={client.client_tag} current={client.start_date} onSaved={reload} />
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

          {/* Group */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-4">
            <span className="text-xs font-medium text-muted-foreground">Group</span>
            {isAdmin ? (
              <Select value={client.group_num ? String(client.group_num) : NO_GROUP}
                onValueChange={(v) => refresh({ action: "set-client-group", client_tag: client.client_tag, group_num: v === NO_GROUP ? null : Number(v) }, "Group updated")}>
                <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_GROUP}>No group yet</SelectItem>
                  {([1, 2] as const).map((g) => <SelectItem key={g} value={String(g)}>{GROUP_META[g].label}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : null}
            <span className="text-sm text-muted-foreground">
              {client.group_num ? groupText(client.group_num).replace(/^Group \d — /, "") : "Not chosen yet — it's picked when the Slack step runs."}
            </span>
          </div>

          {/* Time zone — every campaign of this client sends in it (Clay's "Time Zone" column) */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-xs font-medium text-muted-foreground">Time zone</span>
            {isAdmin ? (
              <Select value={client.campaign_timezone ?? NO_TZ}
                onValueChange={(v) => refresh({ action: "set-client-timezone", client_tag: client.client_tag, timezone: v === NO_TZ ? null : v }, "Time zone updated")}>
                <SelectTrigger className="h-8 w-56 text-xs" aria-label="Campaign time zone"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TZ}>Not chosen yet</SelectItem>
                  {CAMPAIGN_TIMEZONES.map((z) => <SelectItem key={z} value={z}>{timezoneLabel(z)} <span className="text-muted-foreground">· {z}</span></SelectItem>)}
                </SelectContent>
              </Select>
            ) : null}
            <span className="text-sm text-muted-foreground">
              {client.campaign_timezone ? "All of this client's campaigns send in this time zone." : "Pick the time zone of the client's service area."}
            </span>
            {isAdmin && suggestion?.tz && suggestion.tz !== client.campaign_timezone && (
              <button type="button" className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                onClick={() => refresh({ action: "set-client-timezone", client_tag: client.client_tag, timezone: suggestion.tz }, "Time zone updated")}>
                Use {timezoneLabel(suggestion.tz)}{suggestion.from ? ` — office in ${suggestion.from}` : ""}
              </button>
            )}
          </div>

          {/* Email copy — the shared copy for its type, or its own */}
          {isAdmin && <ClientCopyRow tag={client.client_tag} />}
        </CardContent>
      </Card>

      {/* Checklist */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Checklist</h3>
          <AddTaskDialog tag={client.client_tag} users={users} onAdded={reload} />
        </div>
        <ClientChecklist client={client} tasks={tasks} users={users} isAdmin={isAdmin} onChanged={reload} editable />
      </div>

      {isAdmin && (
        <div className="flex items-center gap-2 pt-2">
          <Button variant="outline" size="sm" title="Adds any template task this client doesn't have yet"
            onClick={() => refresh({ action: "regenerate", client_tag: client.client_tag }, "Missing template tasks added")}>
            Add missing template tasks
          </Button>
          <div className="ml-auto">
            <DeleteClientDialog client={client} taskCount={tasks.length} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Which emails this client's campaigns are built from, with a way to give it its own. */
function ClientCopyRow({ tag }: { tag: string }) {
  type Own = { version: number; mode: "custom" | "shared"; clientType: ClientTypeKey; basedOn: number | null };
  const [state, setState] = useState<{ own: Own | null; shared: Record<string, number | null> } | "loading" | "failed">("loading");
  useEffect(() => {
    let live = true;
    fetch(`/api/onboarding/email-copy?client=${encodeURIComponent(tag)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setState(d?.ok ? { own: d.client?.latest ?? null, shared: d.shared ?? {} } : "failed"); })
      .catch(() => { if (live) setState("failed"); });
    return () => { live = false; };
  }, [tag]);
  const href = `/onboarding?copy=${encodeURIComponent(tag)}`;
  const own = typeof state === "object" && state.own?.mode === "custom" ? state.own : null;
  const sharedNow = own && typeof state === "object" ? state.shared[own.clientType] ?? null : null;
  const moved = !!own && own.basedOn != null && sharedNow != null && sharedNow > own.basedOn;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-xs font-medium text-muted-foreground">Email copy</span>
      {state === "loading" ? (
        <span className="h-4 w-48 animate-pulse rounded bg-muted" />
      ) : state === "failed" ? (
        <span className="text-sm text-muted-foreground">Couldn&apos;t load it — <Link href={href} className="text-primary underline-offset-4 hover:underline">open Email copy</Link>.</span>
      ) : own ? (
        <>
          <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300">Own copy · version {own.version}</span>
          <span className="text-sm text-muted-foreground">Its campaigns use this instead of the shared {clientTypeLabel(own.clientType)} copy.</span>
          {moved && <span className="text-xs text-amber-700 dark:text-amber-400">The shared copy has changed since (version {own.basedOn} → {sharedNow}).</span>}
          <Link href={href} className="text-xs font-medium text-primary underline-offset-4 hover:underline">Open it →</Link>
        </>
      ) : (
        <>
          <span className="text-sm text-muted-foreground">Uses the shared copy for its client type.</span>
          <Link href={href} className="text-xs font-medium text-primary underline-offset-4 hover:underline">Give it its own copy →</Link>
        </>
      )}
    </div>
  );
}

function DeleteClientDialog({ client, taskCount }: { client: OnbClient; taskCount: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function del() {
    setBusy(true);
    const r = await postMutate({ action: "delete-client", client_tag: client.client_tag });
    setBusy(false);
    if (r.ok) { toast.success(`${client.client_name || client.client_tag} deleted`); router.push("/onboarding"); }
    else { toast.error(r.error || "Failed to delete"); setOpen(false); }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive">
          Delete client
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {client.client_name || client.client_tag}?</DialogTitle>
          <DialogDescription>
            This removes <span className="font-mono font-semibold">{client.client_tag}</span> from onboarding and permanently
            deletes {taskCount === 0 ? "it" : `all ${taskCount} of its task${taskCount === 1 ? "" : "s"}`}. This can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={del} disabled={busy}>{busy ? "Deleting…" : "Delete client"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
          <DialogDescription>
            Moves every dated task to its day counted from the new start date. Due dates edited by hand, steps without a due date and the group stay as they are.
          </DialogDescription>
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

function AddTaskDialog({ tag, users, onAdded }: { tag: string; users: UserRow[]; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");

  async function submit() {
    if (!title.trim()) { toast.error("Title required"); return; }
    setBusy(true);
    const r = await postMutate({ action: "add-task", client_tag: tag, title, assignee_email: assignee || null, due_date: due || null });
    setBusy(false);
    if (r.ok) { toast.success("Task added"); setOpen(false); setTitle(""); setAssignee(""); setDue(""); onAdded(); }
    else toast.error(r.error || "Failed");
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline">+ Add task</Button></DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a task</DialogTitle>
          <DialogDescription>An extra check-off for this client only. It isn&apos;t added to the template.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Owner</label>
              <Select value={assignee || UNASSIGNED} onValueChange={(v) => setAssignee(v === UNASSIGNED ? "" : v)}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED}>— Unassigned —</SelectItem>
                  {users.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Due date (optional)</label>
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
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
