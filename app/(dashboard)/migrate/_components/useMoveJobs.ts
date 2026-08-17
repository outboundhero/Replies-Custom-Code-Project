"use client";

/**
 * Polls the durable Lead Mover job status and maps server jobs onto the
 * MigrationPanel's MigrationState. The run lives entirely server-side now — this
 * hook is a pure viewer/controller, so closing the tab or dropping Wi-Fi has no
 * effect on progress. Cross jobs → one row per client (campaigns aggregated);
 * same-instance jobs → one row per source campaign.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MigrationState, MoveClientRow, MoveStep } from "./MigrationPanel";

interface TaskView {
  clientTag: string; sourceCampaignName: string; sourceCampaignId: number;
  moved: number; skippedArea: number; skippedLane: number; skippedNoDest: number;
  movedByKey: Record<string, number> | null; totalLeads: number; done: boolean; status: string; error: string | null;
}
interface JobView {
  id: string; runId: string; kind: "cross" | "same"; status: string;
  sourceInstance: string | null; targetInstance: string | null; targetLabel: string | null; targetLane: string | null;
  leadsTotal: number; movedTotal: number; tasksTotal: number; tasksDone: number; tasksFailed: number;
  error: string | null; createdAt: string; finishedAt: string | null;
  tasks: TaskView[];
}

export interface JobEntry {
  jobId: string;
  runId: string;
  kind: "cross" | "same";
  status: "queued" | "running" | "done";
  state: MigrationState;
}

const sum = (arr: TaskView[], f: (t: TaskView) => number) => arr.reduce((s, t) => s + f(t), 0);

function rowState(tasks: TaskView[], jobStatus: string): { state: MoveStep; error?: string; skipReason?: string } {
  const anyFailed = tasks.some((t) => t.status === "failed");
  const real = tasks.filter((t) => t.sourceCampaignId > 0);
  const allSkipped = tasks.length > 0 && tasks.every((t) => t.status === "skipped");
  const realDone = real.length > 0 && real.every((t) => t.status === "done");
  const allTerminal = tasks.every((t) => ["done", "skipped", "failed", "canceled"].includes(t.status));

  if (anyFailed) return { state: "error", error: tasks.find((t) => t.status === "failed")?.error || "failed" };
  if (jobStatus === "canceled" && !realDone) return { state: "error", error: "stopped" };
  if (allSkipped) return { state: "skipped", skipReason: tasks.find((t) => t.error)?.error || "no destination" };
  if (allTerminal && (realDone || real.length === 0)) return { state: "done" };
  if (jobStatus === "running") return { state: "moving" };
  return { state: "queued" };
}

function jobToEntry(job: JobView): JobEntry {
  const status: JobEntry["status"] = job.status === "running" ? "running" : (job.status === "pending" ? "queued" : "done");

  let rows: MoveClientRow[];
  if (job.kind === "cross") {
    const byTag = new Map<string, TaskView[]>();
    for (const t of job.tasks) { if (!byTag.has(t.clientTag)) byTag.set(t.clientTag, []); byTag.get(t.clientTag)!.push(t); }
    rows = [...byTag.entries()].map(([tag, tasks]) => {
      const real = tasks.filter((t) => t.sourceCampaignId > 0);
      const rs = rowState(tasks, job.status);
      return {
        tag, state: rs.state, error: rs.error, skipReason: rs.skipReason,
        totalLeads: sum(tasks, (t) => t.totalLeads), moved: sum(tasks, (t) => t.moved),
        skipped: sum(tasks, (t) => t.skippedArea), skippedLane: sum(tasks, (t) => t.skippedLane), skippedNoDest: sum(tasks, (t) => t.skippedNoDest),
        campaignsTotal: real.length, campaignsDone: real.filter((t) => t.status === "done").length,
        retries: 0, unmatchedEsps: [],
      };
    });
  } else {
    // same-instance: one row per source campaign
    rows = job.tasks.map((t) => {
      const rs = rowState([t], job.status);
      return {
        tag: t.sourceCampaignName || `campaign ${t.sourceCampaignId}`, state: rs.state, error: rs.error, skipReason: rs.skipReason,
        totalLeads: t.totalLeads, moved: t.moved, skipped: t.skippedArea, skippedLane: 0, skippedNoDest: t.skippedNoDest,
        campaignsTotal: t.sourceCampaignId > 0 ? 1 : 0, campaignsDone: t.status === "done" ? 1 : 0,
        retries: 0, unmatchedEsps: [],
      };
    });
  }

  return {
    jobId: job.id, runId: job.runId, kind: job.kind, status,
    state: {
      status: status === "running" ? "running" : status === "queued" ? "queued" : "done",
      from: job.sourceInstance || "", to: job.targetInstance || "",
      lane: (job.targetLane as "b2b" | "b2c" | undefined) || undefined,
      rows,
    },
  };
}

export function useMoveJobs(): {
  entries: JobEntry[];
  cancel: (jobId: string) => Promise<void>;
  retry: (jobId: string) => Promise<void>;
  dismiss: (jobId: string) => void;
  refresh: () => void;
} {
  const [entries, setEntries] = useState<JobEntry[]>([]);
  const dismissed = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/leads/move/jobs/status");
      const d = await res.json();
      if (res.ok && Array.isArray(d.jobs)) {
        const mapped = (d.jobs as JobView[]).filter((j) => !dismissed.current.has(j.id)).map(jobToEntry);
        setEntries(mapped);
        // Fast poll while anything is active; slow down when idle.
        const active = mapped.some((e) => e.status === "running" || e.status === "queued");
        schedule(active ? 3000 : 12000);
        return;
      }
    } catch { /* keep last state */ }
    schedule(8000);
  }, []);

  const schedule = useCallback((ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void poll(); }, ms);
  }, [poll]);

  useEffect(() => {
    void poll();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [poll]);

  const cancel = useCallback(async (jobId: string) => {
    await fetch(`/api/leads/move/jobs/${jobId}/cancel`, { method: "POST" }).catch(() => {});
    void poll();
  }, [poll]);

  const retry = useCallback(async (jobId: string) => {
    await fetch(`/api/leads/move/jobs/${jobId}/retry`, { method: "POST" }).catch(() => {});
    void poll();
  }, [poll]);

  const dismiss = useCallback((jobId: string) => {
    dismissed.current.add(jobId);
    setEntries((prev) => prev.filter((e) => e.jobId !== jobId));
  }, []);

  return { entries, cancel, retry, dismiss, refresh: () => void poll() };
}
