"use client";

/**
 * Jobs — Reply Router's long-running work in one place, with progress, what happened, errors and retries:
 * lead moves, client resets, nurture queue removals, onboarding automations and the campaign refresh.
 * Everything here runs on the server: leaving the page (or closing the browser) doesn't stop it, and finished
 * work stays listed for 30 days. ?tab= opens a tab directly (moves, resets, removals, onboarding, refresh) —
 * read by the page (page.tsx) and passed in.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock, Truck } from "lucide-react";
import { useMoveJobs, MoveJobsCardView } from "@/components/jobs/move-jobs-card";
import { useJobsOverview, ResetsCard, RemovalsCard, OnboardingCard, RefreshCard, JobsLoadError } from "@/components/jobs/other-jobs";
import { TABS, type Tab } from "./tabs";


export default function JobsView({ initialTab }: { initialTab: Tab }) {
  const moves = useMoveJobs();
  const other = useJobsOverview();
  const [tab, setTab] = useState<Tab>(initialTab);
  const pick = (t: Tab) => {
    setTab(t);
    const u = new URL(window.location.href);
    u.searchParams.set("tab", t);
    window.history.replaceState(null, "", u.toString());
  };

  const o = other.data;
  const stats = useMemo(() => {
    const j = moves.jobs;
    const resetsRunning = (o?.resets ?? []).filter((r) => !["done", "failed", "cancelled"].includes(r.status)).length;
    const onbRunning = (o?.onboarding ?? []).filter((x) => x.running).length;
    return {
      running: j.filter((x) => x.status === "running").length + resetsRunning + onbRunning + (o?.refresh.running ? 1 : 0) + (o?.removals ?? []).filter((r) => r.status === "running").length,
      queued: j.filter((x) => x.status === "pending").length,
      finished: j.filter((x) => x.status === "done" || x.status === "failed").length
        + (o?.resets ?? []).filter((r) => r.status === "done").length
        + (o?.onboarding ?? []).filter((x) => !x.running).length
        + (o?.removals ?? []).length,
      moved: j.filter((x) => !x.legacy).reduce((s, x) => s + x.movedTotal, 0),
      attention: j.filter((x) => x.status === "failed" || x.erroredTotal > 0).length
        + (o?.resets ?? []).filter((r) => r.status === "failed").length
        + (o?.onboarding ?? []).filter((x) => x.status === "failed").length
        + (o?.removals ?? []).filter((r) => r.status === "failed").length,
    };
  }, [moves.jobs, o]);

  const counts: Record<Tab, { n: number | null; live: boolean; alert: boolean }> = {
    moves: { n: moves.loaded ? moves.jobs.length : null, live: moves.jobs.some((x) => x.status === "running" || x.status === "pending"), alert: moves.jobs.some((x) => x.status === "failed" || x.erroredTotal > 0) },
    resets: { n: o ? o.resets.length : null, live: !!o?.resets.some((r) => !["done", "failed", "cancelled"].includes(r.status)), alert: !!o?.resets.some((r) => r.status === "failed") },
    removals: { n: o ? o.removals.length : null, live: !!o?.removals.some((r) => r.status === "running"), alert: !!o?.removals.some((r) => r.status === "failed") },
    onboarding: { n: o ? o.onboarding.length : null, live: !!o?.onboarding.some((x) => x.running), alert: !!o?.onboarding.some((x) => x.status === "failed") },
    refresh: { n: null, live: !!o?.refresh.running, alert: !!o?.refresh.last?.failures.length },
  };
  const LABEL: Record<Tab, string> = { moves: "Lead moves", resets: "Client resets", removals: "Queue removals", onboarding: "Onboarding", refresh: "Campaign refresh" };

  const tiles: Array<{ icon: typeof Activity; label: string; value: string; sub: string; tone: string }> = [
    { icon: Activity, label: "Running now", value: String(stats.running), sub: stats.queued ? `${stats.queued} move${stats.queued === 1 ? "" : "s"} queued after` : "nothing queued", tone: "text-sky-700 bg-sky-50 ring-sky-100" },
    { icon: CheckCircle2, label: "Finished", value: String(stats.finished), sub: "in the last 30 days", tone: "text-emerald-700 bg-emerald-50 ring-emerald-100" },
    { icon: Truck, label: "Leads moved", value: stats.moved.toLocaleString(), sub: "by lead moves (since Oct 24)", tone: "text-violet-700 bg-violet-50 ring-violet-100" },
    {
      icon: AlertTriangle, label: "Needs a look", value: String(stats.attention),
      sub: stats.attention ? "failed or with errors (red dot)" : "nothing failed",
      tone: stats.attention ? "text-rose-700 bg-rose-50 ring-rose-100" : "text-slate-600 bg-slate-50 ring-slate-100",
    },
  ];
  const ready = moves.loaded && !!o;

  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">Jobs</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Long-running work and how it went — progress, what was done, errors and retries. It all runs on the server, so leaving this page doesn&apos;t stop anything, and finished jobs stay here for 30 days.
          </p>
        </div>
        <Link href="/migrate" className="inline-flex h-9 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700">
          <Truck className="size-3.5" /> Move leads
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map(({ icon: I, label, value, sub, tone }) => (
          <div key={label} className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm">
            <span className={`grid size-10 shrink-0 place-items-center rounded-lg ring-1 ${tone}`}><I className="size-[18px]" /></span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-xl font-semibold tabular-nums leading-tight">{ready ? value : <span className="inline-block h-5 w-10 animate-pulse rounded bg-muted align-middle" />}</p>
              <p className="truncate text-[11px] text-muted-foreground">{sub}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-4">
        <div role="tablist" className="flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
          {TABS.map((t) => {
            const c = counts[t];
            return (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => pick(t)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors ${tab === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                {c.live && <span className="size-1.5 animate-pulse rounded-full bg-sky-500" title="running now" />}
                {!c.live && c.alert && <span className="size-1.5 rounded-full bg-rose-500" title="something failed" />}
                {LABEL[t]}
                {c.n != null && <span className="rounded bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{c.n}</span>}
              </button>
            );
          })}
        </div>

        <div role="tabpanel">
          {tab === "moves" && <MoveJobsCardView s={moves} />}
          {tab === "resets" && <ResetsCard s={other} />}
          {tab === "removals" && <RemovalsCard s={other} />}
          {tab === "onboarding" && <OnboardingCard s={other} />}
          {tab === "refresh" && <RefreshCard s={other} />}
        </div>
        <JobsLoadError s={other} />
      </div>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="size-3.5" /> Updates every few seconds while something is running.
      </p>
    </div>
  );
}
