"use client";

/**
 * "Lead moves" — every Move Leads run (same instance or cross instance) of the last 30 days, the way the
 * Database's Exports page shows its Bison pushes: one row per move with its progress, what happened to every
 * lead, "Why?" for the ones that didn't move, Retry, Stop and dismiss. The moves run on the server — this only
 * reads their state (polling while any is running), so it's the same for everyone and survives closing the tab.
 * Used on the Jobs page and on Move Leads.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowRight, Download, Loader2, RotateCcw, Square, Truck, X } from "lucide-react";
import { getInstanceLabel } from "@/lib/bison-instances-shared";
import type { JobStatusView, TaskStatusView } from "@/lib/leads/move-jobs";

const ACTIVE = new Set(["pending", "running"]);

/** Polls the moves: every 4 s while one is queued or running, every 20 s otherwise (and not while the tab is hidden). */
export function useMoveJobs() {
  const [jobs, setJobs] = useState<JobStatusView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const poke = useRef<() => void>(() => {});

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function load() {
      if (timer) clearTimeout(timer);
      let next = 20_000;
      try {
        const res = await fetch("/api/leads/move/jobs/status", { cache: "no-store" });
        const d = await res.json().catch(() => ({}));
        if (stopped) return;
        if (res.ok && Array.isArray(d.jobs)) {
          setJobs(d.jobs);
          setFailed(false);
          if ((d.jobs as JobStatusView[]).some((j) => ACTIVE.has(j.status))) next = 4_000;
        } else { setFailed(true); next = 10_000; }
      } catch { if (stopped) return; setFailed(true); next = 10_000; }
      setLoaded(true);
      // Not while the tab is hidden: it checks again later, and coming back to the tab loads at once.
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
  return { jobs, setJobs, loaded, failed, refresh };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function took(a: string | null, b: string | null): string {
  if (!a || !b) return "";
  const m = Math.round((Date.parse(b) - Date.parse(a)) / 60_000);
  return m < 1 ? "under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const n = (x: number) => x.toLocaleString();
const ESP_NAME: Record<string, string> = { google: "Google + Custom", outlook: "Outlook", segs: "SEGs" };

interface Pill { label: string; cls: string }
function statusPill(j: JobStatusView): Pill {
  if (j.status === "pending") return { label: "Queued", cls: "bg-slate-100 text-slate-600 ring-slate-200" };
  if (j.status === "running") return { label: j.retryingTotal > 0 && j.tasksDone === j.tasksTotal ? "Retrying" : "Running", cls: "bg-sky-50 text-sky-700 ring-sky-200" };
  if (j.status === "canceled") return { label: "Stopped", cls: "bg-slate-100 text-slate-600 ring-slate-200" };
  if (j.status === "failed") return { label: "Failed", cls: "bg-rose-50 text-rose-700 ring-rose-200" };
  if (j.erroredTotal > 0) return { label: "Complete · errors", cls: "bg-amber-50 text-amber-800 ring-amber-200" };
  return { label: "Complete", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" };
}

/** Where a task's leads went: "B2B · Google + Custom → JPC: Google + Custom [Nurture] (Cleaning Client)", with counts. */
function routing(t: TaskStatusView): Array<{ key: string; label: string; to: string; count: number }> {
  const out: Array<{ key: string; label: string; to: string; count: number }> = [];
  for (const [key, count] of Object.entries(t.movedByKey ?? {})) {
    if (!count) continue;
    const [lane, esp] = key.includes(":") ? key.split(":") : ["", key];
    const dest = t.dest as Record<string, unknown>;
    const id = Number((lane && typeof dest?.[lane] === "object" ? (dest[lane] as Record<string, unknown>)[esp] : dest?.[esp]) ?? 0);
    const instance = lane === "b2c" ? (t.b2cInstance ?? t.targetInstance) : (t.b2bInstance ?? t.targetInstance);
    out.push({
      key, count,
      label: `${lane ? `${lane.toUpperCase()} · ` : ""}${ESP_NAME[esp] ?? esp}`,
      to: `${(id && t.destNames?.[String(id)]) || (id ? `campaign #${id}` : "?")}${instance ? ` (${getInstanceLabel(instance)})` : ""}`,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

// ── the card ────────────────────────────────────────────────────────────────

export type MoveJobsState = ReturnType<typeof useMoveJobs>;

/** The card, loading its own data. */
export function MoveJobsCard(props: { limit?: number; showAllLink?: boolean }) {
  const s = useMoveJobs();
  return <MoveJobsCardView s={s} {...props} />;
}

/** The card, for a page that already holds the data (useMoveJobs) for other things too. */
export function MoveJobsCardView({ s, limit, showAllLink = false }: { s: MoveJobsState; limit?: number; showAllLink?: boolean }) {
  const { jobs, setJobs, loaded, failed, refresh } = s;
  const [busy, setBusy] = useState<string | null>(null);
  const shown = limit ? jobs.slice(0, limit) : jobs;
  const retryAllCount = jobs.filter((j) => !ACTIVE.has(j.status) && j.status !== "canceled").reduce((s, j) => s + j.retryableTotal, 0);
  const failedCampaigns = jobs.filter((j) => j.status === "failed").reduce((s, j) => s + j.tasksFailed, 0);

  const act = useCallback(async (key: string, url: string, ok: (d: Record<string, number>) => string) => {
    setBusy(key);
    try {
      const res = await fetch(url, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(d.error || "That didn't work — try again.");
      else toast.success(ok(d));
    } catch { toast.error("That didn't work — try again."); }
    finally { setBusy(null); void refresh(); }
  }, [refresh]);

  const dismiss = useCallback(async (id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
    const res = await fetch(`/api/leads/move/jobs/${id}/dismiss`, { method: "POST" }).catch(() => null);
    if (!res?.ok) { toast.error("Couldn't dismiss it — try again."); void refresh(); }
  }, [refresh, setJobs]);

  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-3 border-b px-5 py-4">
        <span className="grid size-9 place-items-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100"><Truck className="size-4" /></span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-tight">Lead moves</h2>
          <p className="text-xs text-muted-foreground">Move Leads runs — same instance and cross instance — of the last 30 days. They run on the server: closing this page doesn&apos;t stop them.</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {(retryAllCount > 0 || failedCampaigns > 0) && (
            <button
              type="button"
              disabled={busy === "all"}
              onClick={() => act("all", "/api/leads/move/jobs/retry-all", (d) => `Queued again: ${n(d.leads ?? 0)} lead${d.leads === 1 ? "" : "s"}${d.tasks ? ` and ${d.tasks} campaign${d.tasks === 1 ? "" : "s"}` : ""} across ${d.jobs ?? 0} move${d.jobs === 1 ? "" : "s"}.`)}
              title="Sends again every lead that hit an error and restarts every campaign that failed, across all finished moves. Leads skipped on purpose (out of area, other lane…) aren't touched."
              className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
            >
              <RotateCcw className={`size-3.5 ${busy === "all" ? "animate-spin" : ""}`} />
              {busy === "all" ? "Retrying…" : `Retry all errors${retryAllCount ? ` (${n(retryAllCount)})` : ""}`}
            </button>
          )}
          {showAllLink && <Link href="/jobs" className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-primary hover:underline">All jobs <ArrowRight className="size-3" /></Link>}
        </div>
      </div>

      <div className="space-y-3 p-4">
        {!loaded ? (
          <div className="space-y-3">{[0, 1].map((i) => <div key={i} className="h-[74px] animate-pulse rounded-xl border bg-muted/30" />)}</div>
        ) : shown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground"><Truck className="size-5" /></span>
            <p className="text-sm font-medium">{failed ? "Couldn't load the moves" : "No moves in the last 30 days"}</p>
            <p className="max-w-sm text-xs text-muted-foreground">{failed ? "It tries again by itself in a few seconds." : <>Start one from <Link href="/migrate" className="text-primary hover:underline">Move Leads</Link> — it shows up here with its progress, and stays here when it&apos;s done.</>}</p>
          </div>
        ) : (
          shown.map((j) => <MoveRow key={j.id} j={j} busy={busy} act={act} dismiss={dismiss} />)
        )}
        {limit && jobs.length > limit && (
          <Link href="/jobs" className="block rounded-lg py-2 text-center text-xs font-medium text-primary hover:bg-muted/40">{n(jobs.length - limit)} more on the Jobs page →</Link>
        )}
      </div>
    </section>
  );
}

type Act = (key: string, url: string, ok: (d: Record<string, number>) => string) => Promise<void>;

function MoveRow({ j, busy, act, dismiss }: { j: JobStatusView; busy: string | null; act: Act; dismiss: (id: string) => void }) {
  const [open, setOpen] = useState<"campaigns" | "why" | null>(null);
  const active = ACTIVE.has(j.status);
  const pill = statusPill(j);
  const real = j.tasks.filter((t) => t.sourceCampaignId > 0);
  const tags = [...new Set(j.tasks.map((t) => t.clientTag))];
  const names = [...new Set(real.map((t) => t.sourceCampaignName))];
  const finished = j.status === "done" || j.status === "failed";
  const pct = j.legacy || j.leadsTotal === 0
    ? (j.tasksTotal ? Math.round((j.tasksDone / j.tasksTotal) * 100) : 0)
    : j.status === "done" ? 100 : Math.min(100, Math.round((j.processedTotal / j.leadsTotal) * 100));
  const bar = j.status === "failed" ? "bg-rose-500" : j.status === "canceled" ? "bg-slate-300" : j.erroredTotal > 0 ? "bg-amber-500" : j.status === "running" ? "bg-sky-500" : j.status === "pending" ? "bg-slate-300" : "bg-emerald-500";
  const route = j.kind === "same" ? "Same instance" : `${getInstanceLabel(j.sourceInstance ?? "")} → ${j.targetLabel ?? getInstanceLabel(j.targetInstance ?? "")}${j.targetLane ? ` (${j.targetLane.toUpperCase()})` : ""}`;
  const canRetry = finished && (j.retryableTotal > 0 || j.tasksFailed > 0);
  const hasWhy = j.erroredTotal > 0 || j.tasksFailed > 0;
  const skip = (x: number, label: string, title?: string) => (x > 0 ? <span title={title}>{n(x)} {label}</span> : null);

  return (
    <div className={`rounded-xl border p-3.5 transition-colors ${j.status === "running" ? "border-sky-200 bg-sky-50/30" : ""}`}>
      <div className="flex items-center gap-2">
        <div className="flex shrink-0 items-center gap-1">
          {tags.slice(0, 3).map((t) => <span key={t} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold">{t}</span>)}
          {tags.length > 3 && <span className="text-[11px] text-muted-foreground" title={tags.join(", ")}>+{tags.length - 3}</span>}
        </div>
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium" title={names.join("\n")}>
          <span className="text-muted-foreground">{route} · </span>{names.join(", ") || "—"}
        </p>
        <span className="shrink-0 text-xs text-muted-foreground" title={`${new Date(j.createdAt).toLocaleString()}${j.createdBy ? ` · by ${j.createdBy}` : ""}`}>{ago(j.createdAt)}</span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${pill.cls}`}>
          {j.status === "running" && <Loader2 className="mr-1 inline size-2.5 animate-spin" />}{pill.label}
        </span>
        {active ? (
          <button type="button" disabled={busy === j.id} onClick={() => act(j.id, `/api/leads/move/jobs/${j.id}/cancel`, () => "Stopped — leads already moved stay where they are.")}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50" title={j.status === "pending" ? "Take it out of the queue" : "Stop after the current batch"}>
            {j.status === "pending" ? <X className="size-3" /> : <Square className="size-3" />}{j.status === "pending" ? "Cancel" : "Stop"}
          </button>
        ) : (
          <button type="button" onClick={() => dismiss(j.id)} aria-label="Dismiss" title="Dismiss — hides this move for everyone"
            className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-3.5" /></button>
        )}
      </div>

      <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full transition-all duration-500 ${bar}`} style={{ width: `${j.status === "pending" ? 0 : pct}%` }} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
        {j.legacy ? (
          <span title="This move ran before Oct 24, when lead-by-lead counting started — its moved count can be too high.">{j.tasksDone}/{j.tasksTotal} campaigns · ~{n(j.movedTotal)} moved (older count, may be high)</span>
        ) : (
          <>
            <span>{n(j.processedTotal)}/{n(j.leadsTotal)} processed</span>
            <span className="font-medium text-foreground">{n(j.movedTotal)} moved</span>
            {j.erroredTotal > 0 && <span className="font-medium text-rose-600">{n(j.erroredTotal)} errored</span>}
            {j.retryingTotal > 0 && <span className="text-sky-700">{n(j.retryingTotal)} being sent again</span>}
            {skip(j.skippedAreaTotal, "out of service area", "Their city isn't in the client's service area — not moved (download them below)")}
            {skip(j.skippedLaneTotal, "other lane", "Personal-email leads in a B2B run (or business ones in a B2C run) — they move in the run to the other instance")}
            {skip(j.skippedNoDestTotal, "no campaign for their ESP", "No destination campaign was picked for that lead's ESP / lane")}
            {skip(j.noEmailTotal, "no email")}
            {skip(j.suppressedTotal, "removed for a service-area change", "The client removed these for a service-area change — never put back")}
            {skip(j.espGuessedTotal, "ESP by email domain", "Email Bison didn't answer these leads' ESP lookups (twice), so they were routed by their email domain")}
          </>
        )}
        {j.tasksFailed > 0 && <span className="font-medium text-rose-600">{j.tasksFailed} campaign{j.tasksFailed === 1 ? "" : "s"} failed</span>}
        <button type="button" onClick={() => setOpen(open === "campaigns" ? null : "campaigns")} className="font-medium text-primary hover:underline">{open === "campaigns" ? "Hide campaigns" : `Campaigns (${real.length})`}</button>
        {hasWhy && <button type="button" onClick={() => setOpen(open === "why" ? null : "why")} className="font-medium text-primary hover:underline">{open === "why" ? "Hide details" : "Why?"}</button>}
        {canRetry && (
          <button type="button" disabled={busy === j.id} onClick={() => act(j.id, `/api/leads/move/jobs/${j.id}/retry`, (d) => `Queued again: ${n(d.leads ?? 0)} lead${d.leads === 1 ? "" : "s"}${d.tasks ? ` and ${d.tasks} campaign${d.tasks === 1 ? "" : "s"}` : ""}.`)}
            className="font-medium text-primary hover:underline disabled:opacity-50">
            {busy === j.id ? "Retrying…" : j.retryableTotal > 0 ? `Retry ${n(j.retryableTotal)} errored` : "Retry failed campaigns"}
          </button>
        )}
        {j.skippedAreaTotal > 0 && (
          <a href={`/api/leads/move/skipped/export?runId=${encodeURIComponent(j.runId)}`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline"><Download className="size-3" />Out-of-area leads</a>
        )}
        {finished && j.startedAt && <span className="ml-auto text-[11px]">took {took(j.startedAt, j.finishedAt)}</span>}
      </div>

      {open === "campaigns" && <Campaigns j={j} />}
      {open === "why" && <Why j={j} />}
    </div>
  );
}

const TASK_PILL: Record<string, string> = {
  pending: "text-slate-500", running: "text-sky-700", done: "text-emerald-700", failed: "text-rose-600", skipped: "text-amber-700", canceled: "text-slate-500",
};

function Campaigns({ j }: { j: JobStatusView }) {
  return (
    <div className="mt-2.5 overflow-x-auto rounded-lg bg-muted/40 p-2">
      <table className="w-full min-w-[640px] text-[11px]">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="px-2 py-1 font-medium">Campaign</th>
            <th className="px-2 py-1 font-medium">State</th>
            <th className="px-2 py-1 text-right font-medium">Processed</th>
            <th className="px-2 py-1 text-right font-medium">Moved</th>
            <th className="px-2 py-1 text-right font-medium">Not moved</th>
            <th className="px-2 py-1 text-right font-medium">Errored</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {j.tasks.map((t) => {
            const notMoved = t.skippedArea + t.skippedLane + t.skippedNoDest + t.noEmail + t.suppressed;
            const routes = routing(t);
            return (
              <tr key={t.id} className="align-top">
                <td className="px-2 py-1.5">
                  <span className="font-medium">{j.kind === "cross" && <span className="mr-1 font-mono">{t.clientTag}</span>}{t.sourceCampaignName || "—"}</span>
                  {routes.length > 0 && (
                    <span className="mt-0.5 block space-y-0.5 text-muted-foreground">
                      {routes.map((r) => <span key={r.key} className="block"><span className="tabular-nums text-foreground">{n(r.count)}</span> → {r.to} <span className="opacity-70">({r.label})</span></span>)}
                    </span>
                  )}
                  {t.error && t.status !== "skipped" && <span className="mt-0.5 block text-rose-600">{t.error}</span>}
                  {t.status === "skipped" && t.error && <span className="mt-0.5 block text-amber-700">{t.error}</span>}
                </td>
                <td className={`px-2 py-1.5 font-medium capitalize ${TASK_PILL[t.status] ?? ""}`}>{t.status === "canceled" ? "stopped" : t.status}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{t.sourceCampaignId > 0 ? `${n(t.processed)}/${n(t.totalLeads)}` : "—"}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{n(t.moved)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums" title={[t.skippedArea && `${n(t.skippedArea)} out of area`, t.skippedLane && `${n(t.skippedLane)} other lane`, t.skippedNoDest && `${n(t.skippedNoDest)} no campaign for their ESP`, t.noEmail && `${n(t.noEmail)} no email`, t.suppressed && `${n(t.suppressed)} removed for a service-area change`].filter(Boolean).join(" · ")}>{n(notMoved)}</td>
                <td className={`px-2 py-1.5 text-right tabular-nums ${t.errored ? "font-medium text-rose-600" : ""}`}>{n(t.errored)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Group { reason: string; count: number; retryable: boolean; status: string; samples: string[] }

function Why({ j }: { j: JobStatusView }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`/api/leads/move/jobs/${j.id}/errors`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { if (live) setGroups(d.groups ?? []); })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [j.id, j.erroredTotal]);
  const failedTasks = j.tasks.filter((t) => t.status === "failed");
  const errored = useMemo(() => (groups ?? []).filter((g) => g.status !== "skipped"), [groups]);
  const leftOut = useMemo(() => (groups ?? []).filter((g) => g.status === "skipped"), [groups]);

  return (
    <div className="mt-2.5 space-y-2.5 rounded-lg bg-muted/40 p-3 text-[11px] leading-snug">
      {failedTasks.length > 0 && (
        <div>
          <p className="mb-1 font-semibold text-rose-600">Campaigns that stopped — Retry starts them again where they stopped</p>
          {failedTasks.map((t) => <p key={t.id}><span className="font-medium">{t.sourceCampaignName}</span> — {t.error ?? "failed"} <span className="text-muted-foreground">({n(t.processed)}/{n(t.totalLeads)} done)</span></p>)}
        </div>
      )}
      {err && <p className="text-rose-600">Couldn&apos;t load the details — close and open again.</p>}
      {!groups && !err && j.erroredTotal > 0 && <p className="text-muted-foreground">Loading details…</p>}
      {errored.length > 0 && (
        <div>
          <p className="mb-1 font-semibold text-rose-600">Errored — {n(j.erroredTotal)} lead{j.erroredTotal === 1 ? "" : "s"}{j.retryableTotal ? `; ${n(j.retryableTotal)} can be sent again with Retry` : ""}</p>
          {errored.map((g) => (
            <p key={`${g.status}|${g.reason}`}>
              <span className="font-medium tabular-nums">{n(g.count)}×</span> {g.reason}
              {g.status === "retrying" && <span className="text-sky-700"> (being sent again)</span>}
              {!g.retryable && <span className="text-muted-foreground"> (retrying won&apos;t help)</span>}
              {g.samples.length > 0 && <span className="text-muted-foreground"> — e.g. {g.samples.join(", ")}</span>}
            </p>
          ))}
        </div>
      )}
      {leftOut.length > 0 && (
        <div>
          <p className="mb-1 font-semibold text-muted-foreground">Left out on retry</p>
          {leftOut.map((g) => <p key={g.reason} className="text-muted-foreground"><span className="font-medium tabular-nums">{n(g.count)}×</span> {g.reason}</p>)}
        </div>
      )}
      {(j.erroredTotal > 0 || leftOut.length > 0) && (
        <a href={`/api/leads/move/jobs/${j.id}/errors?format=csv`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline"><Download className="size-3" />Download these leads (CSV)</a>
      )}
    </div>
  );
}
