"use client";

/**
 * Guided onboarding — one client, every setup step in order. Each step opens
 * with its live preview (exactly what it will do, with every value it will
 * use, editable); "Approve & run" applies it, and the next step opens. Steps
 * that are switched off on this server, or done by hand, say so and can be
 * marked done. Same runs and records as the checklist's Run buttons.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, Circle, Hand, Loader2, Lock, PartyPopper, Plus, Sparkles, Zap,
} from "lucide-react";
import { useSession } from "@/components/session-provider";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AUTOMATION_META, GROUP_META, fmtDate, fmtStamp, shortEmail } from "@/lib/onboarding/ui";
import { timezoneLabel } from "@/lib/onboarding/campaign-plan";
import {
  type OnbClient, type OnbTask, postMutate, setupSteps, taskGate, useStepRun, StepRunBody, TagPill, FormGateBanner,
} from "../../_ui/shared";

/** Short names for the automated steps (the checklist keeps its full titles). */
const STEP_NAME: Record<string, string> = {
  slack_outreachify: "Tell Outreachify on Slack",
  replyrouter_setup: "Set up in Reply Router",
  create_campaigns: "Create the 12 campaigns",
  allocate_domains: "Domains: tag, redirect, attach, 3/day",
  whitelist_email: "Whitelisting email to the client",
  go_live_email: "Go-live email to the client",
};
const stepName = (t: OnbTask) => (t.automation && STEP_NAME[t.automation]) || t.title;

type Kind = "auto" | "preview" | "manual";
/** The steps that have a server switch (the rest are built, or preview-only for now). */
const SWITCHED = new Set(["create_campaigns", "allocate_domains", "whitelist_email"]);
const kindOf = (t: OnbTask): Kind => (t.automation && AUTOMATION_META[t.automation] ? (t.runnable ? "auto" : "preview") : "manual");
const KIND_LABEL: Record<Kind, string> = { auto: "Automatic", preview: "Preview — do by hand", manual: "By hand" };

export default function GuidedOnboardingPage() {
  const params = useParams();
  const session = useSession();
  const isAdmin = session?.role === "admin";
  const tag = decodeURIComponent(String(params.tag || "")).toUpperCase();
  const [client, setClient] = useState<OnbClient | null>(null);
  const [tasks, setTasks] = useState<OnbTask[]>([]);
  const [templateHasRr, setTemplateHasRr] = useState(true);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // While a step runs, nothing else on the page can be clicked away to (the run would carry on unseen).
  const [busy, setBusy] = useState(false);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const router = useRouter();
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    // Any link in the app (the sidebar too) asks first: leaving stops the run after the request in flight.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank") return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname === location.pathname) return;
      e.preventDefault(); e.stopPropagation();
      setLeaveTo(url.pathname + url.search);
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", onClick, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", onClick, true); };
  }, [busy]);

  const load = useCallback(async () => {
    try {
      const b = await fetch("/api/onboarding?fresh=1");
      if (b.status === 401) { window.location.href = "/login"; return; }
      if (!b.ok) { setFailed(`Couldn't load onboarding (${b.status}).`); return; }
      const data = await b.json();
      const c = (data.clients as OnbClient[]).find((x) => x.client_tag.toUpperCase() === tag) ?? null;
      setClient(c);
      setTasks((data.tasks as OnbTask[]).filter((t) => t.client_tag.toUpperCase() === tag));
      setFailed(null);
      // Whether "Set up in Reply Router" is in the template (older checklists can add it).
      const tpl = await fetch("/api/onboarding/template").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (Array.isArray(tpl)) setTemplateHasRr((tpl as { automation: string | null }[]).some((t) => t.automation === "replyrouter_setup"));
    } catch (e) { setFailed((e as Error).message); }
    finally { setLoading(false); }
  }, [tag]);
  useEffect(() => { load(); }, [load]);

  const steps = useMemo(() => setupSteps(tasks), [tasks]);
  const done = steps.filter((t) => t.status === "completed").length;
  // A step left part-way (a run that stopped or failed) is where to pick up; else the first open one.
  const firstOpen = steps.find((t) => t.status === "in_progress") ?? steps.find((t) => t.status !== "completed") ?? null;
  const current = steps.find((t) => t.id === selected) ?? firstOpen ?? steps[steps.length - 1] ?? null;
  const missingRr = !tasks.some((t) => t.automation === "replyrouter_setup");

  const advance = useCallback((fromId: string, skipping = false) => {
    // Next open step after this one (wrapping to any earlier one still open). When skipping, only
    // a step that doesn't wait on another — the ones after this one usually wait on it.
    const i = steps.findIndex((t) => t.id === fromId);
    const open = [...steps.slice(i + 1), ...steps.slice(0, i)].filter((t) => t.status !== "completed" && t.id !== fromId);
    const after = skipping ? open.find((t) => !taskGate(t, tasks).blocker) : open[0];
    if (skipping && !after) { toast.info("The other open steps wait for this one — it has to be done (or marked done) first."); return; }
    setSelected(after?.id ?? null);
  }, [steps, tasks]);

  async function addSetupSteps() {
    const r = await postMutate({ action: "add-setup-steps", client_tag: tag });
    if (r.ok) { toast.success("Added the setup steps."); load(); }
    else toast.error(r.error || "Couldn't add the steps.");
  }
  async function addMissing() {
    // Only this step — tasks someone deleted from this client on purpose stay deleted.
    const r = await postMutate({ action: "add-template-step", client_tag: tag, automation: "replyrouter_setup" });
    if (r.ok) { toast.success("Added “Set up in Reply Router”."); load(); }
    else toast.error(r.error || "Couldn't add the step.");
  }

  if (loading) return <div className="py-16 text-center text-sm text-muted-foreground"><Loader2 className="mx-auto mb-2 size-5 animate-spin" />Loading…</div>;
  if (!isAdmin) return <div className="py-16 text-center text-sm text-muted-foreground">Onboarding is for admins.</div>;
  if (failed && !client) return <div className="mx-auto max-w-2xl py-16 text-center text-sm text-destructive">{failed}</div>;
  if (!client) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 py-10 text-center">
        <p className="text-sm text-muted-foreground"><span className="font-mono font-bold">{tag}</span> isn&apos;t in onboarding yet.</p>
        <Button asChild><Link href="/onboarding">Onboard a client</Link></Button>
      </div>
    );
  }

  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  // "Not chosen yet (step N asks)" while that step is still to do; otherwise point to the client page.
  const askedBy = (automation: string) => {
    const i = steps.findIndex((t) => t.automation === automation);
    return i >= 0 && steps[i].status !== "completed" ? `Not chosen yet (step ${i + 1} asks)` : "Not set — set it on the client page";
  };
  const allDone = steps.length > 0 && done === steps.length;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <Link href={`/onboarding/${encodeURIComponent(client.client_tag)}`} aria-disabled={busy} tabIndex={busy ? -1 : undefined}
        className={cn("inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground", busy && "pointer-events-none opacity-40")}>
        <ArrowLeft className="size-3.5" /> {client.client_tag}&apos;s checklist
      </Link>

      {/* Header */}
      <div className="rounded-2xl border bg-card px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm"><Sparkles className="size-5" /></div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold tracking-tight">Onboarding</h2>
                <TagPill tag={client.client_tag} />
                {client.client_name && <span className="truncate text-sm text-muted-foreground">{client.client_name}</span>}
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">Each step shows exactly what it will do. Approve it and it&apos;s applied — then the next one opens.</p>
            </div>
          </div>
          <div className="w-56 shrink-0">
            <div className="flex items-baseline justify-between text-sm"><span className="font-medium">{done} of {steps.length} done</span><span className="tabular-nums text-muted-foreground">{pct}%</span></div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} /></div>
          </div>
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t pt-4 text-sm sm:grid-cols-4">
          <Fact label="Starts" value={fmtDate(client.start_date)} />
          <Fact label="Group" value={client.group_num ? `${GROUP_META[client.group_num].label} — ${GROUP_META[client.group_num].b2b} + ${GROUP_META[client.group_num].b2c}` : askedBy("slack_outreachify")} warn={!client.group_num} />
          <Fact label="Time zone" value={client.campaign_timezone ? timezoneLabel(client.campaign_timezone) : askedBy("create_campaigns")} warn={!client.campaign_timezone} />
          <Fact label="Plan" value={client.plan_type || "—"} />
        </dl>
      </div>

      {client.status !== "completed" && <FormGateBanner tag={client.client_tag} onReady={load} />}

      {missingRr && steps.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-500/25 bg-sky-500/[0.05] px-4 py-3 text-sm">
          <span>This checklist was made before the <span className="font-medium">Set up in Reply Router</span> step existed{templateHasRr ? "" : " (it isn't in the template either)"}.</span>
          {templateHasRr && <Button size="sm" variant="outline" onClick={addMissing}><Plus /> Add the missing step</Button>}
        </div>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-12">
        {/* The steps */}
        <ol className="space-y-1.5 lg:col-span-4">
          {steps.map((t, i) => {
            const gate = taskGate(t, tasks);
            const isOn = current?.id === t.id;
            const kind = kindOf(t);
            const isDone = t.status === "completed";
            return (
              <li key={t.id}>
                <button type="button" onClick={() => setSelected(t.id)} aria-current={isOn ? "step" : undefined} disabled={busy && !isOn}
                  title={busy && !isOn ? "A step is running — wait for it to finish" : undefined}
                  className={cn("disabled:cursor-not-allowed disabled:opacity-50",
                    "group flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
                    isOn ? "border-foreground/20 bg-card shadow-sm ring-1 ring-foreground/[0.06]" : "border-transparent hover:border-border hover:bg-card/60",
                  )}>
                  <span className={cn(
                    "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold tabular-nums",
                    isDone ? "border-emerald-500 bg-emerald-500 text-white" : isOn ? "border-foreground bg-foreground text-background" : "bg-background text-muted-foreground",
                  )}>{isDone ? <Check className="size-3.5" /> : i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-sm font-medium", isDone && "text-muted-foreground")}>{stepName(t)}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      {isDone ? <span>Done {fmtStamp(t.completed_at)}{t.completed_by ? ` · ${shortEmail(t.completed_by)}` : ""}</span>
                        : gate.blocker ? <span className="inline-flex items-center gap-1"><Lock className="size-3" /> after step {steps.findIndex((x) => x.id === gate.blocker!.id) + 1}</span>
                        : <span className={cn(kind === "auto" && "text-emerald-700 dark:text-emerald-400")}>{KIND_LABEL[kind]}</span>}
                      {t.status === "in_progress" && !isDone && <span className="text-blue-600 dark:text-blue-400">· in progress</span>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          <li className="px-3.5 pt-3 text-xs text-muted-foreground">
            Madison&apos;s and Spencer&apos;s tasks (lead sheet, check-ins, testimonials) follow their dates on the{" "}
            <Link href={`/onboarding/${encodeURIComponent(client.client_tag)}`} className="underline underline-offset-2 hover:text-foreground">checklist</Link>.
          </li>
        </ol>

        {/* The step */}
        <div className="lg:col-span-8">
          {allDone ? (
            <div className="rounded-2xl border bg-card px-6 py-14 text-center">
              <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-emerald-500/10 text-emerald-600"><PartyPopper className="size-6" /></div>
              <h3 className="mt-4 text-lg font-semibold tracking-tight">{client.client_tag} is set up</h3>
              <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">Every setup step is done. The dated tasks carry on from the checklist.</p>
              <Button asChild variant="outline" className="mt-6"><Link href={`/onboarding/${encodeURIComponent(client.client_tag)}`}>Open the checklist</Link></Button>
            </div>
          ) : current ? (
            <StepPanel key={current.id} task={current} index={steps.findIndex((t) => t.id === current.id)} total={steps.length}
              blockedBy={(() => { const b = taskGate(current, tasks).blocker; return b ? { name: stepName(b), n: steps.findIndex((x) => x.id === b.id) + 1, id: b.id } : null; })()}
              onDone={load}
              onFinished={() => { load().then(() => advance(current.id)); }}
              onSkip={() => advance(current.id, true)}
              onGo={(id) => setSelected(id)}
              onRunning={setBusy} />
          ) : (
            <div className="rounded-2xl border border-dashed px-6 py-14 text-center">
              <p className="text-sm font-medium">{client.client_tag}&apos;s checklist has none of the setup steps</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">It was made from an older template, before the guided steps existed. Add them to run them here — the tasks it already has stay as they are.</p>
              <Button className="mt-5" onClick={addSetupSteps}><Plus /> Add the setup steps</Button>
            </div>
          )}
        </div>
      </div>

      <Dialog open={!!leaveTo} onOpenChange={(o) => { if (!o) setLeaveTo(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>A step is running — leave anyway?</DialogTitle>
            <DialogDescription>
              Leaving stops it after the part in flight (one campaign or one batch of domains). Nothing is undone — come back and run the step again to carry on from where it stopped.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLeaveTo(null)}>Stay</Button>
            <Button variant="destructive" onClick={() => { const to = leaveTo; setLeaveTo(null); if (to) router.push(to); }}>Leave and stop it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Fact({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 truncate", warn && "text-amber-700 dark:text-amber-400")} title={value}>{value}</dd>
    </div>
  );
}

function StepPanel({ task, index, total, blockedBy, onDone, onFinished, onSkip, onGo, onRunning }: {
  task: OnbTask; index: number; total: number; blockedBy: { name: string; n: number; id: string } | null;
  onDone: () => void; onFinished: () => void; onSkip: () => void; onGo: (id: string) => void; onRunning: (v: boolean) => void;
}) {
  const kind = kindOf(task);
  const isDone = task.status === "completed";
  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Step {index + 1} of {total}</div>
          <h3 className="mt-0.5 text-lg font-semibold tracking-tight">{stepName(task)}</h3>
          {stepName(task) !== task.title && <div className="text-xs text-muted-foreground">{task.title}</div>}
        </div>
        <span className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
          isDone ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            : kind === "auto" ? "bg-primary/10 text-primary"
            : kind === "preview" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
            : "bg-muted text-muted-foreground",
        )}>
          {isDone ? <CheckCircle2 className="size-3.5" /> : kind === "auto" ? <Zap className="size-3.5" /> : kind === "preview" ? <Circle className="size-3.5" /> : <Hand className="size-3.5" />}
          {isDone ? "Done" : KIND_LABEL[kind]}
        </span>
      </div>

      {isDone ? (
        <DoneBody task={task} onNext={onSkip} />
      ) : blockedBy ? (
        <div className="px-6 py-10 text-center">
          <Lock className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-3 text-sm">This step runs after <span className="font-medium">step {blockedBy.n}: {blockedBy.name}</span>.</p>
          <Button className="mt-5" variant="outline" onClick={() => onGo(blockedBy.id)}>Go to step {blockedBy.n} <ArrowRight /></Button>
        </div>
      ) : kind === "manual" ? (
        <ManualBody task={task} onFinished={onFinished} onSkip={onSkip} />
      ) : (
        <AutoBody task={task} kind={kind} onDone={onDone} onFinished={onFinished} onSkip={onSkip} onRunning={onRunning} />
      )}
    </div>
  );
}

function DoneBody({ task, onNext }: { task: OnbTask; onNext: () => void }) {
  return (
    <div className="space-y-4 px-6 py-6">
      <div className="flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] px-4 py-3 text-sm">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        <div>
          <div className="font-medium">Done {fmtStamp(task.completed_at)}{task.completed_by ? ` by ${shortEmail(task.completed_by)}` : ""}</div>
          {task.last_run?.ok && task.last_run.summary && <div className="mt-0.5 text-muted-foreground">{task.last_run.summary}</div>}
        </div>
      </div>
      <div className="flex justify-end"><Button variant="outline" onClick={onNext}>Next step <ArrowRight /></Button></div>
    </div>
  );
}

function ManualBody({ task, onFinished, onSkip }: { task: OnbTask; onFinished: () => void; onSkip: () => void }) {
  const [busy, setBusy] = useState(false);
  async function markDone() {
    setBusy(true);
    const r = await postMutate({ action: "update-task-status", id: task.id, status: "completed" });
    setBusy(false);
    if (r.ok) { toast.success(`“${task.title}” marked done.`); onFinished(); } else toast.error(r.error || "Couldn't mark it done.");
  }
  return (
    <div className="space-y-5 px-6 py-6">
      <div className="flex items-start gap-3 rounded-xl border bg-muted/30 px-4 py-3 text-sm">
        <Hand className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <div className="font-medium">Done by hand</div>
          <div className="mt-0.5 text-muted-foreground">{task.title}. Mark it done here once it&apos;s finished.</div>
        </div>
      </div>
      <Footer onSkip={onSkip}>
        <Button onClick={markDone} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Check />} Mark done</Button>
      </Footer>
    </div>
  );
}

function AutoBody({ task, kind, onDone, onFinished, onSkip, onRunning }: {
  task: OnbTask; kind: Kind; onDone: () => void; onFinished: () => void; onSkip: () => void; onRunning: (v: boolean) => void;
}) {
  const r = useStepRun(task, { onDone, onSuccess: (summary, open) => { if (open) toast.warning(summary, { duration: 15_000 }); else toast.success(summary); onFinished(); } });
  useEffect(() => { onRunning(r.running); }, [r.running, onRunning]);
  useEffect(() => () => onRunning(false), [onRunning]);
  const [marking, setMarking] = useState(false);
  async function markDone() {
    setMarking(true);
    const m = await postMutate({ action: "update-task-status", id: task.id, status: "completed" });
    setMarking(false);
    if (m.ok) { toast.success(`“${task.title}” marked done.`); onFinished(); } else toast.error(m.error || "Couldn't mark it done.");
  }
  return (
    <div className="space-y-5 px-6 py-6">
      {!r.canRun && kind === "preview" && r.preview && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 text-sm">
          <Circle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div>
            <div className="font-medium">{SWITCHED.has(task.automation ?? "") ? "Switched off on this server — this is a preview" : "Not automated yet — this is a preview"}</div>
            <div className="mt-0.5 text-muted-foreground">Do it by hand as shown below, then mark it done.</div>
          </div>
        </div>
      )}
      {task.last_run && !task.last_run.ok && !r.error && !r.running && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/[0.04] px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            <div className="font-medium text-destructive">The last run stopped{task.last_run.at ? ` (${fmtStamp(task.last_run.at)})` : ""}</div>
            <div className="mt-0.5 text-foreground/80">{task.last_run.summary}</div>
          </div>
        </div>
      )}
      <StepRunBody task={task} r={r} />
      <Footer onSkip={onSkip} disabled={r.running}>
        {r.running && r.progress.length > 0 && <Button variant="ghost" onClick={r.stopAfterBatch} className="text-muted-foreground">Stop after this batch</Button>}
        {/* When it can't run automatically for this client (exempt, OS client, …), it can still be done by hand. */}
        {r.canRun && r.blocked && !r.loading && !r.running && (
          <Button variant="outline" onClick={markDone} disabled={marking}>{marking ? <Loader2 className="animate-spin" /> : <Check />} Done by hand — mark done</Button>
        )}
        {r.canRun ? (
          <Button onClick={r.run} disabled={(r.blocked && !r.loading) || r.running || r.waiting} className="gap-1.5">
            {r.running ? <><Loader2 className="animate-spin" /> Running…</> : r.waiting ? <><Loader2 className="animate-spin" /> Updating preview…</> : <><Zap /> Approve &amp; run</>}
          </Button>
        ) : (
          <Button onClick={markDone} disabled={marking || r.loading}>{marking ? <Loader2 className="animate-spin" /> : <Check />} Done by hand — mark done</Button>
        )}
      </Footer>
    </div>
  );
}

function Footer({ children, onSkip, disabled }: { children: React.ReactNode; onSkip: () => void; disabled?: boolean }) {
  return (
    <div className="-mx-6 -mb-6 flex flex-wrap items-center justify-between gap-3 border-t bg-muted/20 px-6 py-3.5">
      <Button variant="ghost" className="text-muted-foreground" onClick={onSkip} disabled={disabled}>Skip for now</Button>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
