"use client";

/**
 * App-wide progress strip for the durable Lead Mover. Polls active move jobs and
 * shows a compact bar per job from ANY dashboard page — so an operator who
 * started a move and navigated away (or reopened the app) still sees it running
 * to completion. Hidden on /migrate itself (the full panels live there). Reads
 * shared server state, so every operator sees the same jobs.
 */
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Loader2, Clock } from "lucide-react";

interface ActiveJob {
  id: string; status: string; targetLabel: string | null; targetInstance: string | null;
  leadsTotal: number; movedTotal: number; tasksTotal: number; tasksDone: number;
}

export function MoveJobsBanner() {
  const pathname = usePathname();
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let stopped = false;
    const schedule = (ms: number) => { if (!stopped) timer.current = setTimeout(poll, ms); };
    async function poll() {
      try {
        const res = await fetch("/api/leads/move/jobs/status?scope=active");
        const d = await res.json();
        if (!stopped && res.ok && Array.isArray(d.jobs)) {
          setJobs(d.jobs as ActiveJob[]);
          schedule(d.jobs.length ? 4000 : 15000);
          return;
        }
      } catch { /* keep last */ }
      schedule(15000);
    }
    poll();
    return () => { stopped = true; if (timer.current) clearTimeout(timer.current); };
  }, []);

  if (pathname?.startsWith("/migrate")) return null; // full panels shown there
  if (!jobs.length) return null;

  return (
    <div className="mb-4 space-y-2">
      {jobs.map((j) => {
        const running = j.status === "running";
        const pct = j.leadsTotal > 0
          ? Math.min(100, Math.round((j.movedTotal / j.leadsTotal) * 100))
          : (j.tasksTotal > 0 ? Math.round((j.tasksDone / j.tasksTotal) * 100) : 0);
        return (
          <Link key={j.id} href="/migrate" className="block rounded-lg border bg-card px-3 py-2 hover:bg-muted/40 transition-colors">
            <div className="flex items-center gap-2 text-xs">
              {running ? <Loader2 className="size-3.5 animate-spin text-emerald-600" /> : <Clock className="size-3.5 text-slate-500" />}
              <span className="font-medium">{running ? "Moving leads" : "Move queued"}</span>
              {j.targetLabel && <span className="text-muted-foreground truncate">→ {j.targetLabel}</span>}
              <span className="ml-auto tabular-nums text-muted-foreground">
                {j.movedTotal.toLocaleString()}{j.leadsTotal ? ` / ${j.leadsTotal.toLocaleString()}` : ""} leads · {j.tasksDone}/{j.tasksTotal} campaigns
              </span>
            </div>
            <div className="h-1 bg-muted rounded mt-1.5 overflow-hidden">
              <div className={`h-full transition-all duration-300 ${running ? "bg-emerald-500" : "bg-slate-300"}`} style={{ width: `${pct}%` }} />
            </div>
          </Link>
        );
      })}
    </div>
  );
}
