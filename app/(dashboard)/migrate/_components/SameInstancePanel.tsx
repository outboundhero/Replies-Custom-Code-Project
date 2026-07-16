"use client";

/**
 * Live panel for a Same Instance (lane + per-lead-ESP) move. One client, its
 * source campaigns split by email type (business→B2B, personal→B2C) AND by each
 * lead's ESP into the chosen destinations. One row per SOURCE campaign shows a
 * line per destination it fed, with live counts.
 */
import { useMemo } from "react";
import { Loader2, Check, AlertTriangle, X, Square, CircleSlash, RotateCw, Clock } from "lucide-react";

export type SameMoveStep = "queued" | "moving" | "retrying" | "done" | "error" | "skipped";

export interface SameBucket { key: string; lane: "b2b" | "b2c"; esp: string; destName: string; moved: number }
export interface SameSourceRow {
  campaignId: number;
  name: string;
  esp: string;              // source campaign's own ESP (from name) — for display
  sourceSlot: string;       // "B2B 1" / "B2C 1"
  totalLeads: number;
  moved: number;            // total across buckets
  skipped: number;          // leads whose (lane, ESP) had no destination
  skippedArea: number;      // leads skipped by the service-area filter
  buckets: SameBucket[];    // one per destination fed
  state: SameMoveStep;
  retries: number;
  retryAttempt?: number | null;
  error?: string;
}

export interface SameInstanceState {
  status: "queued" | "running" | "done";
  clientTag: string;
  b2bLabel: string;
  b2cLabel: string;
  rows: SameSourceRow[];
}

const ESP_SHORT: Record<string, string> = { google: "G", outlook: "O", segs: "S" };
const STEP_LABEL: Record<SameMoveStep, string> = {
  queued: "queued", moving: "moving", retrying: "retrying", done: "done", error: "error", skipped: "skipped",
};

export default function SameInstancePanel({
  state, running, onStop, onClose, onRetry,
}: {
  state: SameInstanceState;
  running: boolean;
  onStop: () => void;
  onClose: () => void;
  onRetry: (campaignId: number) => void;
}) {
  const { rows, clientTag } = state;
  const queued = state.status === "queued";
  const total = rows.length;
  const done = rows.filter((r) => r.state === "done" || r.state === "error" || r.state === "skipped").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const tally = useMemo(() => {
    let b2b = 0, b2c = 0, retries = 0, errored = 0, doneN = 0, skipped = 0, skippedArea = 0;
    for (const r of rows) {
      retries += r.retries; skipped += r.skipped; skippedArea += r.skippedArea;
      for (const bk of r.buckets) { if (bk.lane === "b2c") b2c += bk.moved; else b2b += bk.moved; }
      if (r.state === "error") errored++;
      if (r.state === "done") doneN++;
    }
    return { b2b, b2c, moved: b2b + b2c, retries, errored, doneN, skipped, skippedArea };
  }, [rows]);

  const ordered = useMemo(() => {
    const order = (s: SameMoveStep) => (s === "moving" || s === "retrying" ? 0 : s === "queued" ? 1 : 2);
    return [...rows].sort((a, b) => order(a.state) - order(b.state));
  }, [rows]);

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b">
        <span className={`grid place-items-center size-8 rounded-lg ${queued ? "bg-slate-100 text-slate-500" : running ? "bg-emerald-100 text-emerald-700" : tally.errored ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600"}`}>
          {queued ? <Clock className="size-4" /> : running ? <Loader2 className="size-4 animate-spin" /> : tally.errored ? <AlertTriangle className="size-4" /> : <Check className="size-4" />}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold flex items-center gap-1.5">
            {queued ? "Queued — waiting to start" : running ? "Moving leads…" : "Move complete"}
            <span className="text-muted-foreground font-normal text-xs">· <span className="font-mono">{clientTag}</span> · {state.b2bLabel} + {state.b2cLabel}</span>
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">{queued ? `${total} campaigns · waiting` : `${done} / ${total} campaigns`}</p>
        </div>
        <div className={`ml-auto hidden md:flex items-center gap-3 text-xs ${queued ? "invisible" : ""}`}>
          <Stat n={tally.moved} label="moved" tone="emerald" />
          <Stat n={tally.b2b} label="→ B2B" tone="indigo" />
          <Stat n={tally.b2c} label="→ B2C" tone="amber2" />
          {tally.retries > 0 && <Stat n={tally.retries} label="retries" tone="amber" />}
          {tally.skipped > 0 && <Stat n={tally.skipped} label="skipped" tone="amber" />}
          {tally.skippedArea > 0 && <Stat n={tally.skippedArea} label="out of area" tone="amber" />}
          {tally.errored > 0 && <Stat n={tally.errored} label="errors" tone="rose" />}
        </div>
        {running ? (
          <button onClick={onStop} className="flex items-center gap-1.5 px-2.5 h-8 text-xs rounded-md border hover:bg-muted/50"><Square className="size-3" /> Stop</button>
        ) : queued ? (
          <button onClick={onStop} className="flex items-center gap-1.5 px-2.5 h-8 text-xs rounded-md border hover:bg-muted/50" title="Remove from queue"><X className="size-3" /> Cancel</button>
        ) : (
          <button onClick={onClose} className="grid place-items-center size-8 rounded-md hover:bg-muted/50" title="Dismiss"><X className="size-4" /></button>
        )}
      </div>
      <div className="h-1 bg-muted">
        <div className={`h-full transition-all duration-300 ${queued ? "bg-slate-300" : tally.errored ? "bg-rose-500" : running ? "bg-emerald-500" : "bg-slate-400"}`} style={{ width: `${queued ? 0 : pct}%` }} />
      </div>

      <div className="max-h-[46vh] overflow-auto p-3 grid grid-cols-1 xl:grid-cols-2 gap-2">
        {ordered.map((r) => <SourceCard key={r.campaignId} r={r} onRetry={onRetry} />)}
      </div>
    </div>
  );
}

const TONE: Record<string, string> = {
  emerald: "text-emerald-700", slate: "text-slate-600", amber: "text-amber-700",
  rose: "text-rose-600", indigo: "text-indigo-700", amber2: "text-amber-600",
};
function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`font-semibold tabular-nums ${TONE[tone]}`}>{n.toLocaleString()}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function SourceCard({ r, onRetry }: { r: SameSourceRow; onRetry: (campaignId: number) => void }) {
  const active = r.state === "moving" || r.state === "retrying";
  const pct = r.state === "done" ? 100 : r.totalLeads > 0 ? Math.min(100, Math.round((r.moved / r.totalLeads) * 100)) : 0;
  const barColor = r.state === "error" ? "bg-rose-500" : r.state === "retrying" ? "bg-amber-500" : r.state === "done" ? "bg-emerald-500" : "bg-emerald-400";
  const icon = r.state === "retrying" ? <RotateCw className="size-3.5 text-amber-600 animate-spin shrink-0" />
    : active ? <Loader2 className="size-3.5 text-emerald-600 animate-spin shrink-0" />
    : r.state === "done" ? <Check className="size-3.5 text-emerald-600 shrink-0" />
    : r.state === "error" ? <AlertTriangle className="size-3.5 text-rose-500 shrink-0" />
    : r.state === "skipped" ? <CircleSlash className="size-3.5 text-amber-500 shrink-0" />
    : <span className="size-3.5 shrink-0 rounded-full border border-muted-foreground/30" />;

  const buckets = [...r.buckets].filter((b) => b.moved > 0).sort((a, b) => (a.lane === b.lane ? a.esp.localeCompare(b.esp) : a.lane.localeCompare(b.lane)));

  return (
    <div className={`rounded-lg border px-3 py-2 ${active ? "bg-emerald-50/40 border-emerald-200" : r.state === "error" ? "bg-rose-50/40 border-rose-200" : "bg-card"}`}>
      <div className="flex items-center gap-2">
        {icon}
        <span className="inline-flex items-center justify-center size-4 rounded bg-slate-100 text-slate-600 text-[9px] font-semibold shrink-0">{ESP_SHORT[r.esp] || "?"}</span>
        <span className="text-[9px] font-medium rounded bg-slate-100 px-1 py-0.5 text-slate-600 shrink-0">{r.sourceSlot}</span>
        <span className="text-xs font-medium truncate" title={r.name}>{r.name}</span>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground shrink-0">
          {r.moved.toLocaleString()}{r.totalLeads > 0 ? ` / ${r.totalLeads.toLocaleString()}` : ""}
        </span>
      </div>

      {/* Per-destination breakdown */}
      {buckets.length > 0 && (
        <div className="mt-1 space-y-0.5 text-[10px]">
          {buckets.map((b) => (
            <div key={b.key} className="flex items-center gap-1.5">
              <span className={`shrink-0 font-medium ${b.lane === "b2c" ? "text-amber-700" : "text-indigo-700"}`}>{b.lane === "b2c" ? "B2C" : "B2B"} {ESP_SHORT[b.esp] || "?"}</span>
              <span className="text-muted-foreground truncate" title={b.destName}>{b.destName}</span>
              <span className="ml-auto tabular-nums font-medium text-foreground shrink-0">{b.moved.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      <div className="h-1 bg-muted rounded mt-1.5 overflow-hidden">
        <div className={`h-full transition-all duration-300 ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center gap-1.5 mt-1 text-[11px] text-muted-foreground min-h-4">
        {r.state === "error" ? (
          <>
            <span className="text-rose-600 truncate flex-1" title={r.error}>{r.error}</span>
            <button onClick={() => onRetry(r.campaignId)} className="inline-flex items-center gap-1 px-1.5 h-5 rounded border text-[10px] hover:bg-muted/50"><RotateCw className="size-2.5" /> Retry</button>
          </>
        ) : r.state === "retrying" ? (
          <span className="text-amber-700">retrying… (attempt {r.retryAttempt || 1}/5)</span>
        ) : (
          <>
            <span className={active ? "text-emerald-700 font-medium" : ""}>{STEP_LABEL[r.state]}</span>
            {r.skipped > 0 && <span className="text-amber-600">· {r.skipped.toLocaleString()} skipped (no dest)</span>}
            {r.skippedArea > 0 && <span className="text-amber-600">· {r.skippedArea.toLocaleString()} out of area</span>}
            {r.retries > 0 && r.state !== "done" && <span className="text-amber-600">· {r.retries} retries</span>}
          </>
        )}
      </div>
    </div>
  );
}
