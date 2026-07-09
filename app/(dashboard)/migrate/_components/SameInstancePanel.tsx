"use client";

/**
 * Live panel for a Same Instance (lane-aware) move — one client, its source
 * campaigns split by email type into B2B (business) and B2C (personal)
 * destinations, matched by ESP. One row per SOURCE campaign shows the full
 * split: business → B2B campaign (count) and personal → B2C campaign (count).
 */
import { useMemo } from "react";
import { Loader2, Check, AlertTriangle, X, Square, CircleSlash, RotateCw } from "lucide-react";

export type SameMoveStep = "queued" | "moving" | "retrying" | "done" | "error" | "skipped";

export interface SameSourceRow {
  campaignId: number;
  name: string;
  esp: string;
  sourceSlot: string;        // "B2B 1" / "B2C 1" — where the source campaign lives
  totalLeads: number;
  movedB2b: number;
  movedB2c: number;
  b2bDest: string | null;    // destination campaign name for business leads
  b2cDest: string | null;    // destination campaign name for personal leads
  skipped: number;           // leads whose lane had no destination
  state: SameMoveStep;
  retries: number;
  retryAttempt?: number | null;
  error?: string;
}

export interface SameInstanceState {
  status: "running" | "done";
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
  const total = rows.length;
  const done = rows.filter((r) => r.state === "done" || r.state === "error" || r.state === "skipped").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const tally = useMemo(() => {
    let b2b = 0, b2c = 0, retries = 0, errored = 0, doneN = 0, skipped = 0;
    for (const r of rows) {
      b2b += r.movedB2b; b2c += r.movedB2c; retries += r.retries; skipped += r.skipped;
      if (r.state === "error") errored++;
      if (r.state === "done") doneN++;
    }
    return { b2b, b2c, moved: b2b + b2c, retries, errored, doneN, skipped };
  }, [rows]);

  const ordered = useMemo(() => {
    const order = (s: SameMoveStep) => (s === "moving" || s === "retrying" ? 0 : s === "queued" ? 1 : 2);
    return [...rows].sort((a, b) => order(a.state) - order(b.state));
  }, [rows]);

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b">
        <span className={`grid place-items-center size-8 rounded-lg ${running ? "bg-emerald-100 text-emerald-700" : tally.errored ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600"}`}>
          {running ? <Loader2 className="size-4 animate-spin" /> : tally.errored ? <AlertTriangle className="size-4" /> : <Check className="size-4" />}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold flex items-center gap-1.5">
            {running ? "Moving leads…" : "Move complete"}
            <span className="text-muted-foreground font-normal text-xs">· <span className="font-mono">{clientTag}</span> · {state.b2bLabel} + {state.b2cLabel}</span>
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">{done} / {total} campaigns</p>
        </div>
        <div className="ml-auto hidden md:flex items-center gap-3 text-xs">
          <Stat n={tally.moved} label="moved" tone="emerald" />
          <Stat n={tally.b2b} label="→ B2B" tone="indigo" />
          <Stat n={tally.b2c} label="→ B2C" tone="amber2" />
          {tally.retries > 0 && <Stat n={tally.retries} label="retries" tone="amber" />}
          {tally.skipped > 0 && <Stat n={tally.skipped} label="skipped" tone="amber" />}
          {tally.errored > 0 && <Stat n={tally.errored} label="errors" tone="rose" />}
        </div>
        {running ? (
          <button onClick={onStop} className="flex items-center gap-1.5 px-2.5 h-8 text-xs rounded-md border hover:bg-muted/50"><Square className="size-3" /> Stop</button>
        ) : (
          <button onClick={onClose} className="grid place-items-center size-8 rounded-md hover:bg-muted/50" title="Dismiss"><X className="size-4" /></button>
        )}
      </div>
      <div className="h-1 bg-muted">
        <div className={`h-full transition-all duration-300 ${tally.errored ? "bg-rose-500" : running ? "bg-emerald-500" : "bg-slate-400"}`} style={{ width: `${pct}%` }} />
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
  const moved = r.movedB2b + r.movedB2c;
  const pct = r.state === "done" ? 100 : r.totalLeads > 0 ? Math.min(100, Math.round((moved / r.totalLeads) * 100)) : 0;
  const barColor = r.state === "error" ? "bg-rose-500" : r.state === "retrying" ? "bg-amber-500" : r.state === "done" ? "bg-emerald-500" : "bg-emerald-400";
  const icon = r.state === "retrying" ? <RotateCw className="size-3.5 text-amber-600 animate-spin shrink-0" />
    : active ? <Loader2 className="size-3.5 text-emerald-600 animate-spin shrink-0" />
    : r.state === "done" ? <Check className="size-3.5 text-emerald-600 shrink-0" />
    : r.state === "error" ? <AlertTriangle className="size-3.5 text-rose-500 shrink-0" />
    : r.state === "skipped" ? <CircleSlash className="size-3.5 text-amber-500 shrink-0" />
    : <span className="size-3.5 shrink-0 rounded-full border border-muted-foreground/30" />;

  return (
    <div className={`rounded-lg border px-3 py-2 ${active ? "bg-emerald-50/40 border-emerald-200" : r.state === "error" ? "bg-rose-50/40 border-rose-200" : "bg-card"}`}>
      <div className="flex items-center gap-2">
        {icon}
        <span className="inline-flex items-center justify-center size-4 rounded bg-slate-100 text-slate-600 text-[9px] font-semibold shrink-0">{ESP_SHORT[r.esp] || "?"}</span>
        <span className="text-[9px] font-medium rounded bg-slate-100 px-1 py-0.5 text-slate-600 shrink-0">{r.sourceSlot}</span>
        <span className="text-xs font-medium truncate" title={r.name}>{r.name}</span>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground shrink-0">
          {moved.toLocaleString()}{r.totalLeads > 0 ? ` / ${r.totalLeads.toLocaleString()}` : ""}
        </span>
      </div>

      {/* Lane split — business → B2B, personal → B2C */}
      <div className="mt-1 space-y-0.5 text-[10px]">
        <LaneLine label="business → B2B" dest={r.b2bDest} n={r.movedB2b} tone="text-indigo-700" />
        <LaneLine label="personal → B2C" dest={r.b2cDest} n={r.movedB2c} tone="text-amber-700" />
      </div>

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
            {r.retries > 0 && r.state !== "done" && <span className="text-amber-600">· {r.retries} retries</span>}
          </>
        )}
      </div>
    </div>
  );
}

function LaneLine({ label, dest, n, tone }: { label: string; dest: string | null; n: number; tone: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`shrink-0 ${tone}`}>{label}</span>
      {dest
        ? <span className="text-muted-foreground truncate" title={dest}>{dest}</span>
        : <span className="text-muted-foreground/50 italic">no destination</span>}
      {dest && <span className="ml-auto tabular-nums font-medium text-foreground shrink-0">{n.toLocaleString()}</span>}
    </div>
  );
}
