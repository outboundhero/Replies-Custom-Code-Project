"use client";

/**
 * Jobs — Reply Router's long-running work in one place, with progress, what happened, errors and retries.
 * Everything here runs on the server: leaving the page (or closing the browser) doesn't stop it, and a finished
 * job stays listed for 30 days. Today: Lead moves (Move Leads, same + cross instance).
 */
import Link from "next/link";
import { useMemo } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock, Truck } from "lucide-react";
import { useMoveJobs, MoveJobsCardView } from "@/components/jobs/move-jobs-card";

export default function JobsPage() {
  const moves = useMoveJobs();
  const stats = useMemo(() => {
    const j = moves.jobs;
    return {
      running: j.filter((x) => x.status === "running").length,
      queued: j.filter((x) => x.status === "pending").length,
      finished: j.filter((x) => x.status === "done" || x.status === "failed").length,
      moved: j.filter((x) => !x.legacy).reduce((s, x) => s + x.movedTotal, 0),
      errored: j.reduce((s, x) => s + x.erroredTotal, 0),
      failedCampaigns: j.filter((x) => x.status === "failed").reduce((s, x) => s + x.tasksFailed, 0),
    };
  }, [moves.jobs]);

  const tiles: Array<{ icon: typeof Activity; label: string; value: string; sub: string; tone: string }> = [
    { icon: Activity, label: "Running now", value: String(stats.running), sub: stats.queued ? `${stats.queued} queued after` : "nothing queued", tone: "text-sky-700 bg-sky-50 ring-sky-100" },
    { icon: CheckCircle2, label: "Finished", value: String(stats.finished), sub: "in the last 30 days", tone: "text-emerald-700 bg-emerald-50 ring-emerald-100" },
    { icon: Truck, label: "Leads moved", value: stats.moved.toLocaleString(), sub: "by the moves listed (since Oct 24)", tone: "text-violet-700 bg-violet-50 ring-violet-100" },
    {
      icon: AlertTriangle, label: "Errored leads", value: stats.errored.toLocaleString(),
      sub: stats.failedCampaigns ? `+ ${stats.failedCampaigns} campaign${stats.failedCampaigns === 1 ? "" : "s"} stopped` : stats.errored ? "Retry sends them again" : "none waiting",
      tone: stats.errored || stats.failedCampaigns ? "text-rose-700 bg-rose-50 ring-rose-100" : "text-slate-600 bg-slate-50 ring-slate-100",
    },
  ];

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
              <p className="text-xl font-semibold tabular-nums leading-tight">{moves.loaded ? value : <span className="inline-block h-5 w-10 animate-pulse rounded bg-muted align-middle" />}</p>
              <p className="truncate text-[11px] text-muted-foreground">{sub}</p>
            </div>
          </div>
        ))}
      </div>

      <MoveJobsCardView s={moves} />

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="size-3.5" /> Updates every few seconds while something is running.
      </p>
    </div>
  );
}
