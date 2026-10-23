"use client";

/**
 * The Jobs page's other long-running work, beside Lead moves: client resets, nurture queue removals, onboarding
 * automation runs and the campaign refresh — the same row style as the Lead moves card (status, progress, what was
 * done, errors) with each feature's own actions (Try again / Cancel, Undo, Refresh now) and a link to where it lives.
 * Data: GET /api/jobs/overview, polled (faster while something runs, not while the tab is hidden).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowUpRight, Check, Loader2, RefreshCw, RotateCcw, Undo2, X } from "lucide-react";
import type { JobsOverview, OnboardingJob, RemovalJob, ResetJob, StepState } from "@/lib/jobs/overview";

export function useJobsOverview() {
  const [data, setData] = useState<JobsOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const poke = useRef<() => void>(() => {});
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function load() {
      if (timer) clearTimeout(timer);
      let next = 30_000;
      try {
        const res = await fetch("/api/jobs/overview", { cache: "no-store" });
        const d = await res.json().catch(() => ({}));
        if (stopped) return;
        if (res.ok && d.resets) {
          setData(d);
          setFailed(false);
          const busy = (d as JobsOverview).resets.some((r) => !["done", "failed", "cancelled"].includes(r.status))
            || (d as JobsOverview).onboarding.some((j) => j.running) || (d as JobsOverview).refresh.running
            || (d as JobsOverview).removals.some((r) => r.status === "running");
          if (busy) next = 6_000;
        } else { setFailed(true); next = 15_000; }
      } catch { if (stopped) return; setFailed(true); next = 15_000; }
      const tick = () => { if (stopped) return; if (document.visibilityState === "visible") void load(); else timer = setTimeout(tick, next); };
      timer = setTimeout(tick, next);
    }
    poke.current = () => void load();
    void load();
    const onShow = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onShow);
    return () => { stopped = true; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onShow); };
  }, []);
  const refresh = useCallback(() => poke.current(), []);
  return { data, failed, refresh };
}
export type JobsOverviewState = ReturnType<typeof useJobsOverview>;

// ── shared bits ─────────────────────────────────────────────────────────────

const n = (x: number) => x.toLocaleString();
function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
function took(a: string | null, b: string | null): string {
  if (!a || !b) return "";
  const sec = Math.round((Date.parse(b) - Date.parse(a)) / 1000);
  if (sec < 60) return `${Math.max(1, sec)} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const short = (email: string | null) => (email ? email.split("@")[0] : "");

const PILL: Record<string, string> = {
  running: "bg-sky-50 text-sky-700 ring-sky-200", done: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  failed: "bg-rose-50 text-rose-700 ring-rose-200", stopped: "bg-slate-100 text-slate-600 ring-slate-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-200", muted: "bg-slate-100 text-slate-600 ring-slate-200",
};
function Pill({ tone, children, spin }: { tone: keyof typeof PILL; children: React.ReactNode; spin?: boolean }) {
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${PILL[tone]}`}>
      {spin && <Loader2 className="mr-1 inline size-2.5 animate-spin" />}{children}
    </span>
  );
}
function Tag({ t }: { t: string }) {
  return <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold">{t}</span>;
}
function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={`h-full rounded-full transition-all duration-500 ${tone}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}
function Card({ icon, title, sub, right, children }: { icon: React.ReactNode; title: string; sub: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-3 border-b px-5 py-4">
        <span className="grid size-9 place-items-center rounded-lg bg-muted text-foreground/70 ring-1 ring-border">{icon}</span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-tight">{title}</h2>
          <p className="text-xs text-muted-foreground">{sub}</p>
        </div>
        {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
      </div>
      <div className="space-y-3 p-4">{children}</div>
    </section>
  );
}
function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">{icon}</span>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{text}</p>
    </div>
  );
}
function Skeleton() {
  return <div className="space-y-3">{[0, 1].map((i) => <div key={i} className="h-[74px] animate-pulse rounded-xl border bg-muted/30" />)}</div>;
}
async function post(url: string, body: unknown): Promise<{ ok: boolean; d: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, d: await res.json().catch(() => ({})) };
  } catch { return { ok: false, d: { error: "No connection — try again." } }; }
}

/** Inline "Are you sure?" for a destructive or slow action. */
function Confirm({ label, question, run, tone = "text-primary" }: { label: React.ReactNode; question: string; run: () => Promise<void>; tone?: string }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) return <button type="button" onClick={() => setAsking(true)} className={`font-medium hover:underline ${tone}`}>{label}</button>;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5">
      <span className="text-foreground">{question}</span>
      <button type="button" disabled={busy} onClick={async () => { setBusy(true); await run(); setBusy(false); setAsking(false); }} className="font-semibold text-primary hover:underline disabled:opacity-50">{busy ? "…" : "Yes"}</button>
      <button type="button" disabled={busy} onClick={() => setAsking(false)} className="text-muted-foreground hover:underline">No</button>
    </span>
  );
}

// ── resets ──────────────────────────────────────────────────────────────────

const STEP_DOT: Record<StepState, string> = { done: "bg-emerald-500", now: "bg-sky-500 animate-pulse", todo: "bg-slate-300", failed: "bg-rose-500", skipped: "bg-transparent ring-1 ring-slate-300" };
const RESET_STEP: Record<string, string> = { creating: "making campaigns", attaching: "attaching inboxes", repointing: "switching nurture", emptying: "emptying the queue", archiving: "archiving old campaigns" };

export function ResetsCard({ s }: { s: JobsOverviewState }) {
  const rows = s.data?.resets ?? null;
  return (
    <Card icon={<RotateCcw className="size-4" />} title="Client resets" sub="Hard resets (All Clients) and nurture resets, last 30 days — step by step. They run on the server.">
      {!rows ? <Skeleton /> : rows.length === 0 ? (
        <Empty icon={<RotateCcw className="size-5" />} title="No resets in the last 30 days" text="A reset started from a client's page (Hard reset) or its Nurture page (Reset nurture) shows up here." />
      ) : rows.map((r) => <ResetRow key={r.id} r={r} refresh={s.refresh} />)}
    </Card>
  );
}

function ResetRow({ r, refresh }: { r: ResetJob; refresh: () => void }) {
  const working = !["done", "failed", "cancelled"].includes(r.status);
  const tone = r.status === "done" ? "done" : r.status === "failed" ? "failed" : r.status === "cancelled" ? "stopped" : "running";
  const label = r.status === "done" ? "Done" : r.status === "failed" ? "Stopped" : r.status === "cancelled" ? "Cancelled" : r.status === "cancelling" ? "Cancelling" : `Running · ${RESET_STEP[r.status] ?? r.status}`;
  const bar = r.status === "failed" ? "bg-rose-500" : r.status === "cancelled" ? "bg-slate-300" : r.status === "done" ? "bg-emerald-500" : "bg-sky-500";
  const act = async (action: "retry" | "cancel") => {
    const { ok, d } = await post(`/api/clients/${encodeURIComponent(r.tag)}/hard-reset`, { action, id: r.id });
    if (ok) toast.success(action === "retry" ? "Trying again — it carries on where it stopped." : "Cancelling — the new campaigns it made are deleted (never one with leads).");
    else toast.error(String(d.error ?? "That didn't work."));
    refresh();
  };
  return (
    <div className={`rounded-xl border p-3.5 ${working ? "border-sky-200 bg-sky-50/30" : ""}`}>
      <div className="flex items-center gap-2">
        <Tag t={r.tag} />
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{r.kind === "nurture" ? "Nurture reset" : "Hard reset"} <span className="font-normal text-muted-foreground">· #{r.id}{r.createdBy ? ` · by ${short(r.createdBy)}` : ""}</span></p>
        <span className="shrink-0 text-xs text-muted-foreground" title={new Date(r.createdAt).toLocaleString()}>{ago(r.createdAt)}</span>
        <Pill tone={tone} spin={working}>{label}</Pill>
      </div>
      <Bar pct={r.progress} tone={bar} />
      <ol className="mt-2.5 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-5">
        {r.steps.map((st) => (
          <li key={st.key} className="flex min-w-0 items-start gap-1.5">
            <span className={`mt-1 size-2 shrink-0 rounded-full ${STEP_DOT[st.state]}`} />
            <span className="min-w-0">
              <span className={`block font-medium ${st.state === "failed" ? "text-rose-600" : st.state === "todo" || st.state === "skipped" ? "text-muted-foreground" : ""}`}>{st.label}</span>
              <span className="block text-[11px] text-muted-foreground">{st.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      {r.error && <p className={`mt-2 text-xs ${r.status === "failed" ? "text-rose-600" : "text-muted-foreground"}`}>{r.error}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {r.canRetry && <Confirm label="Try again" question="Carry on from where it stopped?" run={() => act("retry")} />}
        {r.canCancel && <Confirm label="Cancel" tone="text-rose-600" question="Cancel? The new campaigns it made are deleted." run={() => act("cancel")} />}
        <Link href={`/clients/${encodeURIComponent(r.tag)}`} className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">Open client <ArrowUpRight className="size-3" /></Link>
        {r.finishedAt && <span className="ml-auto text-[11px] text-muted-foreground">took {took(r.createdAt, r.finishedAt)}</span>}
      </div>
    </div>
  );
}

// ── queue removals ──────────────────────────────────────────────────────────

export function RemovalsCard({ s }: { s: JobsOverviewState }) {
  const rows = s.data?.removals ?? null;
  return (
    <Card icon={<Undo2 className="size-4" />} title="Nurture queue removals" sub="Contacts taken out of a client's nurture queue — by hand (Remove all / selected), by a reset or for a service-area change. Most can be undone.">
      {!rows ? <Skeleton /> : rows.length === 0 ? (
        <Empty icon={<Undo2 className="size-5" />} title="No queue removals in the last 30 days" text="Removals made from a client's Nurture page, by a reset or for a service-area change show up here." />
      ) : rows.map((r) => <RemovalRow key={r.id} r={r} refresh={s.refresh} />)}
    </Card>
  );
}

function RemovalRow({ r, refresh }: { r: RemovalJob; refresh: () => void }) {
  const tone = r.status === "done" ? "done" : r.status === "failed" ? "failed" : r.status === "running" ? "running" : "muted";
  const label = r.status === "done" ? "Removed" : r.status === "failed" ? "Failed" : r.status === "running" ? "Running" : "Undone";
  const undo = async () => {
    const { ok, d } = await post("/api/nurture/queue/restore", { removalId: r.id });
    if (ok) toast.success(`Put back: ${n(Number(d.contacts ?? r.contacts))} contact${r.contacts === 1 ? "" : "s"} are in ${r.tag}'s queue again.`);
    else toast.error(String(d.error ?? "That didn't work."));
    refresh();
  };
  return (
    <div className="rounded-xl border p-3.5">
      <div className="flex items-center gap-2">
        <Tag t={r.tag} />
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{r.label}</p>
        <span className="shrink-0 text-xs text-muted-foreground" title={new Date(r.at).toLocaleString()}>{ago(r.at)}</span>
        <Pill tone={tone} spin={r.status === "running"}>{label}</Pill>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
        <span className="font-medium text-foreground">{n(r.contacts)} contact{r.contacts === 1 ? "" : "s"}</span>
        {r.rows !== r.contacts && <span>{n(r.rows)} queue rows</span>}
        {r.by && <span>by {short(r.by)}</span>}
        {r.restoredAt && <span className="text-slate-600">undone {ago(r.restoredAt)}{r.restoredBy ? ` by ${short(r.restoredBy)}` : ""}{r.restoredRows != null ? ` · ${n(r.restoredRows)} rows back` : ""}</span>}
        {r.error && <span className="text-rose-600">{r.error}</span>}
        {r.mode === "service-area" && r.status === "done" && <span title="Let leads back in from the client's Service area changes">kept out for a service-area change</span>}
        {r.undoable && <Confirm label={<span className="inline-flex items-center gap-1"><Undo2 className="size-3" />Undo</span>} question={`Put the ${n(r.contacts)} back in the queue?`} run={undo} />}
        <Link href={`/nurture/c/${encodeURIComponent(r.tag)}`} className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">Open nurture <ArrowUpRight className="size-3" /></Link>
      </div>
    </div>
  );
}

// ── onboarding runs ─────────────────────────────────────────────────────────

export function OnboardingCard({ s }: { s: JobsOverviewState }) {
  const rows = s.data?.onboarding ?? null;
  return (
    <Card icon={<Check className="size-4" />} title="Onboarding automations" sub="Checklist steps run for new clients — campaign creation, domain allocation, emails, set-up. A step that ran in several rounds is one row.">
      {!rows ? <Skeleton /> : rows.length === 0 ? (
        <Empty icon={<Check className="size-5" />} title="No onboarding runs in the last 30 days" text={<>Steps run from <Link href="/onboarding" className="text-primary hover:underline">Onboarding</Link> show up here.</>} />
      ) : rows.map((j) => <OnboardingRow key={j.key} j={j} />)}
    </Card>
  );
}

function OnboardingRow({ j }: { j: OnboardingJob }) {
  const tone = j.status === "done" ? "done" : j.status === "failed" ? "failed" : j.status === "running" ? "running" : "warn";
  const label = j.status === "done" ? "Done" : j.status === "failed" ? "Failed" : j.status === "running" ? "Running" : "Done · retried";
  return (
    <div className={`rounded-xl border p-3.5 ${j.running ? "border-sky-200 bg-sky-50/30" : ""}`}>
      <div className="flex items-center gap-2">
        <Tag t={j.tag} />
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{j.label}</p>
        <span className="shrink-0 text-xs text-muted-foreground" title={new Date(j.startedAt).toLocaleString()}>{ago(j.startedAt)}</span>
        <Pill tone={tone} spin={j.running}>{label}</Pill>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
        <span className="font-medium text-foreground">{j.summary}</span>
        {j.runs > 1 && <span>{j.runs} rounds{j.failed ? ` · ${j.failed} failed` : ""}</span>}
        {j.by && <span>by {short(j.by)}</span>}
        <Link href={`/onboarding/${encodeURIComponent(j.tag)}/run`} className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">Open onboarding <ArrowUpRight className="size-3" /></Link>
        {j.finishedAt && <span className="ml-auto text-[11px]">took {took(j.startedAt, j.finishedAt)}</span>}
      </div>
      {j.lastError && <p className={`mt-1.5 text-xs ${j.status === "failed" ? "text-rose-600" : "text-muted-foreground"}`}>{j.status === "failed" ? "" : "An earlier round failed: "}{j.lastError}</p>}
    </div>
  );
}

// ── campaign refresh ────────────────────────────────────────────────────────

export function RefreshCard({ s }: { s: JobsOverviewState }) {
  const r = s.data?.refresh ?? null;
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/nurture/refresh-campaigns", { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(d.error || "The refresh didn't work.");
      else if (d.busy) toast.message("A refresh is already running — it'll be done in a moment.");
      else toast.success(`Refreshed: ${n(Number(d.cached ?? 0))} nurture + ${n(Number(d.mains ?? 0))} main campaigns from all 4 instances${(d.failures ?? []).length ? ` (couldn't read: ${(d.failures as string[]).join(", ")})` : ""}.`);
    } catch { toast.error("The refresh didn't work."); }
    finally { setBusy(false); s.refresh(); }
  };
  return (
    <Card icon={<RefreshCw className="size-4" />} title="Campaign refresh" sub="Every campaign pulled from all 4 Email Bison instances — every 10 minutes by itself, or now with the button. The Nurture pages read it."
      right={<button type="button" disabled={busy || !!r?.running} onClick={run} className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"><RefreshCw className={`size-3.5 ${busy || r?.running ? "animate-spin" : ""}`} />{busy || r?.running ? "Refreshing…" : "Refresh now"}</button>}>
      {!r ? <Skeleton /> : (
        <>
          <div className={`rounded-xl border p-3.5 ${r.running ? "border-sky-200 bg-sky-50/30" : ""}`}>
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-[13px] font-medium">{r.running ? "Refreshing now" : "Last refresh"}</p>
              {r.last && <span className="text-xs text-muted-foreground" title={new Date(r.last.at).toLocaleString()}>{ago(r.last.at)}</span>}
              <Pill tone={r.running ? "running" : r.last?.failures.length ? "warn" : "done"} spin={r.running}>{r.running ? "Running" : r.last?.failures.length ? "Done · partly" : "Done"}</Pill>
            </div>
            {r.last ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
                <span className="font-medium text-foreground">{n(r.last.cached)} nurture + {n(r.last.mains)} main campaigns</span>
                <span>took {Math.round(r.last.ms / 1000)} s</span>
                <span>{r.last.manual ? `by ${short(r.last.by) || "someone"} (button)` : "automatic (every 10 min)"}</span>
                {r.last.revived != null && <span title="Completed nurture campaigns that nurture still sends to, started again">{r.last.revived} completed nurture campaign{r.last.revived === 1 ? "" : "s"} revived</span>}
                {r.last.failures.length > 0 && <span className="text-amber-700">couldn&apos;t read: {r.last.failures.join(", ")} — the next refresh tries again</span>}
              </div>
            ) : <p className="mt-2 text-xs text-muted-foreground">No refresh recorded yet.</p>}
          </div>
          {r.manual.length > 0 && (
            <div className="rounded-xl border p-3.5">
              <p className="mb-1.5 text-xs font-medium">Refreshed with the button (last 30 days)</p>
              <ul className="space-y-1 text-xs tabular-nums text-muted-foreground">
                {r.manual.map((m) => (
                  <li key={m.at} className="flex flex-wrap gap-x-3">
                    <span className="text-foreground" title={new Date(m.at).toLocaleString()}>{ago(m.at)}</span>
                    {m.by && <span>by {short(m.by)}</span>}
                    {m.cached != null && <span>{n(m.cached)} nurture campaigns</span>}
                    {m.ms != null && <span>{Math.round(m.ms / 1000)} s</span>}
                    {m.failures.length > 0 && <span className="text-amber-700">couldn&apos;t read: {m.failures.join(", ")}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function JobsLoadError({ s }: { s: JobsOverviewState }) {
  if (!s.failed || s.data) return null;
  return <p className="flex items-center gap-1.5 text-xs text-rose-600"><X className="size-3.5" /> Couldn&apos;t load resets, removals and onboarding runs — it tries again by itself.</p>;
}
