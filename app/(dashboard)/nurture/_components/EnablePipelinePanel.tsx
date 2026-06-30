"use client";

/**
 * Live progress panel for the Automation-tab bulk "Enable" pipeline. For each
 * selected client (with a CONFIRMED map) it runs: route all ready leads → attach
 * client-tagged inboxes → activate the campaigns. Clients without a confirmed map
 * are listed as skipped. Mirrors the AutoMapPanel / SyncProgressPanel idiom.
 */
import { useMemo } from "react";
import { Loader2, Check, AlertTriangle, X, Square, CircleSlash, Zap } from "lucide-react";

export type EnableStep = "queued" | "routing" | "inboxes" | "activating" | "done" | "error" | "skipped";

export interface EnableClientRow {
  tag: string;
  state: EnableStep;
  routed: number;
  routeBatches: number;
  inboxesAttached: number;
  activated: number;
  error?: string;
  skipReason?: string;
}

export interface EnablePipelineState {
  status: "running" | "done";
  rows: EnableClientRow[];
}

const STEP_LABEL: Record<EnableStep, string> = {
  queued: "queued",
  routing: "routing ready leads…",
  inboxes: "attaching inboxes…",
  activating: "activating campaigns…",
  done: "done",
  error: "error",
  skipped: "skipped",
};

export default function EnablePipelinePanel({
  state,
  running,
  onStop,
  onClose,
}: {
  state: EnablePipelineState;
  running: boolean;
  onStop: () => void;
  onClose: () => void;
}) {
  const { rows } = state;
  const total = rows.length;
  const done = rows.filter((r) => r.state === "done" || r.state === "error" || r.state === "skipped").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const tally = useMemo(() => {
    let routed = 0, inboxes = 0, activated = 0, skipped = 0, errored = 0;
    for (const r of rows) {
      routed += r.routed; inboxes += r.inboxesAttached; activated += r.activated;
      if (r.state === "skipped") skipped++;
      if (r.state === "error") errored++;
    }
    return { routed, inboxes, activated, skipped, errored };
  }, [rows]);

  // In-flight clients first, then the rest.
  const ordered = useMemo(() => {
    const active = rows.filter((r) => r.state !== "queued" && r.state !== "done" && r.state !== "skipped" && r.state !== "error");
    const rest = rows.filter((r) => !active.includes(r));
    return [...active, ...rest];
  }, [rows]);

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-card">
        <div className="flex items-center gap-3 px-4 py-3 border-b">
          <span className={`grid place-items-center size-8 rounded-lg ${running ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
            {running ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{running ? "Enabling sending…" : "Enable complete"}</p>
            <p className="text-xs text-muted-foreground tabular-nums">{done} / {total} client{total === 1 ? "" : "s"}</p>
          </div>
          <div className="ml-auto hidden sm:flex items-center gap-3 text-xs">
            <Stat n={tally.routed} label="routed" tone="emerald" />
            <Stat n={tally.inboxes} label="inboxes" tone="sky" />
            <Stat n={tally.activated} label="activated" tone="violet" />
            {tally.skipped > 0 && <Stat n={tally.skipped} label="skipped" tone="amber" />}
          </div>
          {running ? (
            <button onClick={onStop} className="flex items-center gap-1.5 px-2.5 h-8 text-xs rounded-md border hover:bg-muted/50">
              <Square className="size-3" /> Stop
            </button>
          ) : (
            <button onClick={onClose} className="grid place-items-center size-8 rounded-md hover:bg-muted/50" title="Dismiss">
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="h-1 bg-muted">
          <div className={`h-full transition-all duration-300 ${running ? "bg-emerald-500" : "bg-slate-400"}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Live feed */}
      <div className="max-h-[58vh] overflow-auto divide-y">
        {ordered.map((r) => <ClientRow key={r.tag} r={r} />)}
      </div>

      {/* Footer */}
      {!running && (
        <div className="px-4 py-3 border-t bg-muted/20 text-xs text-muted-foreground">
          Routed <span className="font-medium text-emerald-700">{tally.routed.toLocaleString()}</span> lead{tally.routed === 1 ? "" : "s"} ·
          {" "}<span className="font-medium text-sky-700">{tally.inboxes.toLocaleString()}</span> inboxes attached ·
          {" "}<span className="font-medium text-violet-700">{tally.activated.toLocaleString()}</span> campaigns activated
          {tally.skipped > 0 && <> · <span className="text-amber-700">{tally.skipped}</span> skipped (map not confirmed)</>}
          {tally.errored > 0 && <> · <span className="text-rose-600">{tally.errored}</span> errored</>}.
        </div>
      )}
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: "emerald" | "sky" | "violet" | "amber" }) {
  const color = { emerald: "text-emerald-700", sky: "text-sky-700", violet: "text-violet-700", amber: "text-amber-700" }[tone];
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`font-semibold tabular-nums ${color}`}>{n.toLocaleString()}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function ClientRow({ r }: { r: EnableClientRow }) {
  const active = r.state === "routing" || r.state === "inboxes" || r.state === "activating";
  const icon = active ? <Loader2 className="size-4 text-emerald-600 animate-spin shrink-0 mt-0.5" />
    : r.state === "done" ? <Check className="size-4 text-emerald-600 shrink-0 mt-0.5" />
    : r.state === "error" ? <AlertTriangle className="size-4 text-rose-500 shrink-0 mt-0.5" />
    : r.state === "skipped" ? <CircleSlash className="size-4 text-amber-500 shrink-0 mt-0.5" />
    : <Zap className="size-4 text-slate-300 shrink-0 mt-0.5" />;

  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      {icon}
      <span className="w-24 shrink-0 font-mono text-sm font-semibold truncate" title={r.tag}>{r.tag}</span>
      <div className="flex-1 min-w-0 text-xs">
        {r.state === "skipped" ? (
          <span className="text-amber-700">skipped — {r.skipReason || "map not confirmed"}</span>
        ) : r.state === "error" ? (
          <span className="text-rose-600 truncate" title={r.error}>error — {r.error}</span>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums text-muted-foreground">
            {active && <span className="text-emerald-700 font-medium">{STEP_LABEL[r.state]}</span>}
            <span><span className="text-emerald-700 font-medium">{r.routed.toLocaleString()}</span> routed{r.routeBatches ? ` (${r.routeBatches} batches)` : ""}</span>
            {(r.state === "activating" || r.state === "done") && <span><span className="text-sky-700 font-medium">{r.inboxesAttached.toLocaleString()}</span> inboxes</span>}
            {r.state === "done" && <span><span className="text-violet-700 font-medium">{r.activated.toLocaleString()}</span> activated</span>}
            {r.state === "done" && <span className="text-emerald-700">✓ done</span>}
          </div>
        )}
      </div>
    </div>
  );
}
