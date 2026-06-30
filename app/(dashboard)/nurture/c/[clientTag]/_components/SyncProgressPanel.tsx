"use client";

/**
 * Live progress panel for the "Sync Sequence-Finished" button. Streams one row
 * per source campaign (active / paused / completed / archived) as the sync
 * scans it, showing how many sequence-finished leads were found and written to
 * the nurture queue, with the ESP split (Google / Outlook / SEGs). Mirrors the
 * AutoMapPanel / EnableSendingProgress visual idiom.
 */
import { useMemo } from "react";
import { Loader2, Check, AlertTriangle, X, RefreshCw, CircleSlash } from "lucide-react";

export interface SyncCampaignRow {
  key: string;            // `${instance}:${campaignId}`
  instance: string;
  campaignId: number;
  name: string;
  status: string;         // active / paused / completed / archived …
  totalLeads: number;
  state: "pending" | "done" | "error";
  candidates?: number;    // sequence-finished leads found
  upserted?: number;      // rows written to the queue
  esp?: { google: number; outlook: number; segs: number; other: number };
  error?: string;
}

export interface SyncProgressState {
  status: "idle" | "running" | "done" | "error";
  instances: string[];
  campaigns: SyncCampaignRow[];
  found: number;          // running total of sequence-finished leads found
  upserted: number;       // running total written to the queue
  error?: string;
  startedAt: number | null;
}

export default function SyncProgressPanel({
  progress,
  onClose,
}: {
  progress: SyncProgressState;
  onClose: () => void;
}) {
  const { status, instances, campaigns, found, upserted } = progress;
  const running = status === "running";

  const done = campaigns.filter((c) => c.state !== "pending").length;
  const total = campaigns.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : running ? 5 : 100;

  // Newest-first feed, but keep pending (in-flight) at the top so the active
  // campaigns are always visible.
  const ordered = useMemo(() => {
    const pending = campaigns.filter((c) => c.state === "pending");
    const finished = campaigns.filter((c) => c.state !== "pending");
    return [...pending, ...finished.reverse()];
  }, [campaigns]);

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      {/* ── Sticky header ── */}
      <div className="sticky top-0 z-10 bg-card">
        <div className="flex items-center gap-3 px-4 py-3 border-b">
          <span className={`grid place-items-center size-8 rounded-lg ${running ? "bg-sky-100 text-sky-700" : status === "error" ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>
            {running ? <Loader2 className="size-4 animate-spin" /> : status === "error" ? <AlertTriangle className="size-4" /> : <Check className="size-4" />}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">
              {running ? "Syncing sequence-finished leads…" : status === "error" ? "Sync failed" : "Sync complete"}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {done} / {total || "…"} campaign{total === 1 ? "" : "s"}
              {instances.length ? <> · {instances.join(" + ")}</> : null}
            </p>
          </div>

          <div className="ml-auto hidden sm:flex items-center gap-3 text-xs">
            <Stat n={found} label="found" tone="sky" />
            <Stat n={upserted} label="queued" tone="emerald" />
          </div>

          {running ? (
            <span className="grid place-items-center size-8 text-muted-foreground" title="Working…">
              <RefreshCw className="size-4 animate-spin" />
            </span>
          ) : (
            <button onClick={onClose} className="grid place-items-center size-8 rounded-md hover:bg-muted/50" title="Dismiss">
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="h-1 bg-muted">
          <div
            className={`h-full transition-all duration-300 ${status === "error" ? "bg-rose-500" : running ? "bg-sky-500" : "bg-emerald-500"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* ── Live feed ── */}
      <div className="max-h-[58vh] overflow-auto divide-y">
        {status === "error" && progress.error && (
          <div className="px-4 py-3 text-sm text-rose-600">{progress.error}</div>
        )}
        {ordered.map((c) => <CampaignRow key={c.key} c={c} />)}
        {total === 0 && running && (
          <div className="flex items-center gap-3 px-4 py-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin shrink-0" /> Enumerating campaigns…
          </div>
        )}
        {total === 0 && !running && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No source campaigns with sequence-finished leads were found.
          </div>
        )}
      </div>

      {/* ── Footer summary ── */}
      {!running && total > 0 && (
        <div className="px-4 py-3 border-t bg-muted/20 text-xs text-muted-foreground">
          Scanned <span className="font-medium text-foreground">{total}</span> campaign{total === 1 ? "" : "s"} · found{" "}
          <span className="font-medium text-sky-700">{found.toLocaleString()}</span> sequence-finished lead{found === 1 ? "" : "s"} ·{" "}
          <span className="font-medium text-emerald-700">{upserted.toLocaleString()}</span> written to the nurture queue.
        </div>
      )}
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: "sky" | "emerald" }) {
  const color = tone === "sky" ? "text-sky-700" : "text-emerald-700";
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`font-semibold tabular-nums ${color}`}>{n.toLocaleString()}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  paused: "bg-amber-50 text-amber-700 ring-amber-200",
  completed: "bg-slate-100 text-slate-600 ring-slate-200",
  stopped: "bg-slate-100 text-slate-600 ring-slate-200",
  archived: "bg-violet-50 text-violet-700 ring-violet-200",
  draft: "bg-slate-100 text-slate-500 ring-slate-200",
};

function CampaignRow({ c }: { c: SyncCampaignRow }) {
  const icon =
    c.state === "pending" ? <Loader2 className="size-4 text-muted-foreground animate-spin shrink-0 mt-0.5" />
    : c.state === "error" ? <AlertTriangle className="size-4 text-rose-500 shrink-0 mt-0.5" />
    : (c.candidates ?? 0) > 0 ? <Check className="size-4 text-emerald-600 shrink-0 mt-0.5" />
    : <CircleSlash className="size-4 text-slate-400 shrink-0 mt-0.5" />;

  const tone = STATUS_TONE[c.status?.toLowerCase()] || "bg-slate-100 text-slate-600 ring-slate-200";

  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate max-w-[28rem]" title={c.name}>{c.name}</span>
          <span className={`text-[10px] font-medium rounded px-1.5 py-0.5 ring-1 ring-inset ${tone}`}>{c.status || "—"}</span>
          <span className="text-[11px] text-muted-foreground font-mono">{c.instance}</span>
        </div>
        {c.state === "error" ? (
          <p className="text-xs text-rose-600 mt-0.5 truncate" title={c.error}>{c.error}</p>
        ) : c.state === "done" ? (
          <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
            {(c.candidates ?? 0).toLocaleString()} found
            {(c.upserted ?? 0) > 0 && <> · <span className="text-emerald-700">{(c.upserted ?? 0).toLocaleString()} queued</span></>}
            {c.esp && (c.esp.google + c.esp.outlook + c.esp.segs) > 0 && (
              <span className="ml-1 text-muted-foreground/80">
                ({[c.esp.google && `${c.esp.google} G`, c.esp.outlook && `${c.esp.outlook} O`, c.esp.segs && `${c.esp.segs} S`].filter(Boolean).join(" · ")})
              </span>
            )}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground/70 mt-0.5">scanning… {c.totalLeads.toLocaleString()} leads</p>
        )}
      </div>
    </div>
  );
}
