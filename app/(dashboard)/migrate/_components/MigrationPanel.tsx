"use client";

/**
 * Sticky, top-of-page live panel for the Lead Mover batch migration. Shows the
 * whole run side-by-side: an overall header (progress bar + tallies + Stop) and
 * a responsive grid with one card per selected client, each updating live —
 * moving / retrying / done / error, with a per-client bar and ESP legend.
 */
import { useMemo } from "react";
import { Loader2, Check, AlertTriangle, X, Square, CircleSlash, ArrowRight, RotateCw, Download, MapPin } from "lucide-react";
import { getInstanceLabel } from "@/lib/bison-instances-shared";

export type MoveStep = "queued" | "matching" | "moving" | "retrying" | "done" | "error" | "skipped";

export interface MoveClientRow {
  tag: string;
  state: MoveStep;
  totalLeads: number;
  moved: number;
  campaignsTotal: number;
  campaignsDone: number;
  currentEsp?: string | null;
  retries: number;
  retryAttempt?: number | null;
  unmatchedEsps: string[];
  error?: string;
  skipReason?: string;
  /** Leads skipped by the service-area gate for this client (distinct from the
   *  whole-client `state:"skipped"` = no destination). */
  skipped: number;
  /** Whether a service-area filter is configured for this client (false → the
   *  filter was OFF for it, so ALL its leads move). */
  serviceArea?: boolean;
}

export interface MigrationState {
  status: "running" | "done";
  from: string;
  to: string;
  rows: MoveClientRow[];
}

const STEP_LABEL: Record<MoveStep, string> = {
  queued: "queued", matching: "matching…", moving: "moving", retrying: "retrying",
  done: "done", error: "error", skipped: "skipped",
};

export default function MigrationPanel({
  state, running, onStop, onClose, onRetry, onExportSkipped,
}: {
  state: MigrationState;
  running: boolean;
  onStop: () => void;
  onClose: () => void;
  onRetry: (tag: string) => void;
  onExportSkipped?: () => void;
}) {
  const { rows, from, to } = state;
  const total = rows.length;
  const done = rows.filter((r) => r.state === "done" || r.state === "error" || r.state === "skipped").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const tally = useMemo(() => {
    let moved = 0, retries = 0, skipped = 0, errored = 0, doneN = 0, skippedLeads = 0;
    for (const r of rows) {
      moved += r.moved; retries += r.retries; skippedLeads += r.skipped || 0;
      if (r.state === "skipped") skipped++;
      if (r.state === "error") errored++;
      if (r.state === "done") doneN++;
    }
    return { moved, retries, skipped, errored, doneN, skippedLeads };
  }, [rows]);

  // Active/retrying first, then queued, then finished.
  const ordered = useMemo(() => {
    const order = (s: MoveStep) => (s === "moving" || s === "matching" || s === "retrying" ? 0 : s === "queued" ? 1 : 2);
    return [...rows].sort((a, b) => order(a.state) - order(b.state));
  }, [rows]);

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      {/* Overall header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b">
        <span className={`grid place-items-center size-8 rounded-lg ${running ? "bg-emerald-100 text-emerald-700" : tally.errored ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600"}`}>
          {running ? <Loader2 className="size-4 animate-spin" /> : tally.errored ? <AlertTriangle className="size-4" /> : <Check className="size-4" />}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold flex items-center gap-1.5">
            {running ? "Migrating leads…" : "Migration complete"}
            <span className="text-muted-foreground font-normal inline-flex items-center gap-1 text-xs">
              · {getInstanceLabel(from)} <ArrowRight className="size-3" /> {getInstanceLabel(to)}
            </span>
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">{done} / {total} clients</p>
        </div>
        <div className="ml-auto hidden md:flex items-center gap-3 text-xs">
          <Stat n={tally.moved} label="leads moved" tone="emerald" />
          <Stat n={tally.doneN} label="done" tone="slate" />
          {tally.retries > 0 && <Stat n={tally.retries} label="retries" tone="amber" />}
          {tally.skippedLeads > 0 && <Stat n={tally.skippedLeads} label="out of area" tone="amber" />}
          {tally.skipped > 0 && <Stat n={tally.skipped} label="no dest" tone="amber" />}
          {tally.errored > 0 && <Stat n={tally.errored} label="errors" tone="rose" />}
        </div>
        {tally.skippedLeads > 0 && onExportSkipped && (
          <button onClick={onExportSkipped} className="flex items-center gap-1.5 px-2.5 h-8 text-xs rounded-md border hover:bg-muted/50" title="Download the out-of-area leads that were skipped"><Download className="size-3" /> Skipped CSV</button>
        )}
        {running ? (
          <button onClick={onStop} className="flex items-center gap-1.5 px-2.5 h-8 text-xs rounded-md border hover:bg-muted/50"><Square className="size-3" /> Stop</button>
        ) : (
          <button onClick={onClose} className="grid place-items-center size-8 rounded-md hover:bg-muted/50" title="Dismiss"><X className="size-4" /></button>
        )}
      </div>
      {/* Progress bar */}
      <div className="h-1 bg-muted">
        <div className={`h-full transition-all duration-300 ${tally.errored ? "bg-rose-500" : running ? "bg-emerald-500" : "bg-slate-400"}`} style={{ width: `${pct}%` }} />
      </div>

      {/* Per-client grid */}
      <div className="max-h-[46vh] overflow-auto p-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
        {ordered.map((r) => <ClientCard key={r.tag} r={r} onRetry={onRetry} />)}
      </div>
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: "emerald" | "slate" | "amber" | "rose" }) {
  const color = { emerald: "text-emerald-700", slate: "text-slate-600", amber: "text-amber-700", rose: "text-rose-600" }[tone];
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`font-semibold tabular-nums ${color}`}>{n.toLocaleString()}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

const ESP_SHORT: Record<string, string> = { google: "G", outlook: "O", segs: "S" };

function ClientCard({ r, onRetry }: { r: MoveClientRow; onRetry: (tag: string) => void }) {
  const active = r.state === "moving" || r.state === "matching" || r.state === "retrying";
  // A finished client shows a full bar — the summed source total can exceed the
  // moved count (a lead in two source campaigns is created once), so done ≠ 100%.
  const pct = r.state === "done" ? 100 : r.totalLeads > 0 ? Math.min(100, Math.round((r.moved / r.totalLeads) * 100)) : 0;
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
        <span className="font-mono text-sm font-semibold truncate">{r.tag}</span>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {r.moved.toLocaleString()}{r.totalLeads > 0 ? ` / ${r.totalLeads.toLocaleString()}` : ""}
        </span>
      </div>
      <div className="h-1 bg-muted rounded mt-1.5 overflow-hidden">
        <div className={`h-full transition-all duration-300 ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center gap-1.5 mt-1 text-[11px] text-muted-foreground min-h-4">
        {r.state === "skipped" ? (
          <span className="text-amber-700">skipped — {r.skipReason || "no destination"}</span>
        ) : r.state === "error" ? (
          <>
            <span className="text-rose-600 truncate flex-1" title={r.error}>{r.error}</span>
            <button onClick={() => onRetry(r.tag)} className="inline-flex items-center gap-1 px-1.5 h-5 rounded border text-[10px] hover:bg-muted/50"><RotateCw className="size-2.5" /> Retry</button>
          </>
        ) : r.state === "retrying" ? (
          <span className="text-amber-700">retrying… (attempt {r.retryAttempt || 1}/5)</span>
        ) : (
          <>
            <span className={active ? "text-emerald-700 font-medium" : ""}>
              {STEP_LABEL[r.state]}{r.state === "moving" && r.currentEsp ? ` ${ESP_SHORT[r.currentEsp] || r.currentEsp}` : ""}
            </span>
            {r.campaignsTotal > 0 && <span>· {r.campaignsDone}/{r.campaignsTotal} campaigns</span>}
            {r.skipped > 0 && <span className="text-amber-600">· {r.skipped.toLocaleString()} out of area</span>}
            {r.serviceArea === false && <span className="inline-flex items-center gap-0.5 text-muted-foreground/70" title="No service area configured — all leads move"><MapPin className="size-2.5" /> no area filter</span>}
            {r.unmatchedEsps.length > 0 && <span className="text-amber-600">· {r.unmatchedEsps.map((e) => ESP_SHORT[e] || e).join("")} unmatched</span>}
            {r.retries > 0 && r.state !== "done" && <span className="text-amber-600">· {r.retries} retries</span>}
          </>
        )}
      </div>
    </div>
  );
}
