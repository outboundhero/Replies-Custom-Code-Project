"use client";

/**
 * Counts-only progress panel for a bulk blacklist run, pinned at the top of the
 * Blacklist page. Deliberately shows ONLY numbers (Blacklisted / Already /
 * Skipped / Failed + processed/total) — never the individual emails/domains, so
 * it stays clean on big lists. Visual idiom mirrors SyncProgressPanel.
 */
import { Loader2, Check, AlertTriangle, X, RotateCw, Square } from "lucide-react";

export interface BlacklistProgress {
  status: "running" | "done" | "error";
  kind: "email" | "domain";
  instances: string[];
  total: number; // sendable items (post pre-filter)
  processed: number; // items resolved so far
  blacklisted: number;
  already: number;
  skipped: number; // pre-filtered (personal + malformed) — never sent
  failed: number;
  configErrors: string[]; // instance keys that couldn't be configured
}

export default function BlacklistProgressPanel({
  progress, running, onStop, onClose, onRetry, failedCount,
}: {
  progress: BlacklistProgress;
  running: boolean;
  onStop: () => void;
  onClose: () => void;
  onRetry: () => void;
  failedCount: number;
}) {
  const { status, kind, instances, total, processed, blacklisted, already, skipped, failed, configErrors } = progress;
  const pct = total > 0 ? Math.round((processed / total) * 100) : running ? 5 : 100;
  const errored = status === "error" || configErrors.length > 0;

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b">
        <span className={`grid place-items-center size-8 rounded-lg ${running ? "bg-sky-100 text-sky-700" : errored ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>
          {running ? <Loader2 className="size-4 animate-spin" /> : errored ? <AlertTriangle className="size-4" /> : <Check className="size-4" />}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {running ? `Blacklisting ${kind === "domain" ? "domains" : "emails"}…` : errored ? "Finished with errors" : "Blacklist complete"}
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {processed.toLocaleString()} / {total.toLocaleString()} · {instances.join(" + ")}
          </p>
        </div>

        <div className="ml-auto hidden sm:flex items-center gap-3 text-xs">
          <Stat n={blacklisted} label="blacklisted" tone="emerald" />
          <Stat n={already} label="already" tone="slate" />
          {skipped > 0 && <Stat n={skipped} label="skipped" tone="amber" />}
          {failed > 0 && <Stat n={failed} label="failed" tone="rose" />}
        </div>

        {running ? (
          <button onClick={onStop} className="flex items-center gap-1.5 px-2.5 h-8 text-xs rounded-md border hover:bg-muted/50 ml-3"><Square className="size-3" /> Stop</button>
        ) : (
          <div className="flex items-center gap-2 ml-3">
            {failedCount > 0 && (
              <button onClick={onRetry} className="flex items-center gap-1.5 px-2.5 h-8 text-xs rounded-md border border-rose-200 text-rose-700 hover:bg-rose-50"><RotateCw className="size-3" /> Retry {failedCount.toLocaleString()} failed</button>
            )}
            <button onClick={onClose} className="grid place-items-center size-8 rounded-md hover:bg-muted/50" title="Dismiss"><X className="size-4" /></button>
          </div>
        )}
      </div>

      <div className="h-1 bg-muted">
        <div className={`h-full transition-all duration-300 ${errored && !running ? "bg-rose-500" : running ? "bg-sky-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
      </div>

      {/* Mobile / always-visible count row */}
      <div className="flex sm:hidden items-center gap-3 px-4 py-2 text-xs border-b">
        <Stat n={blacklisted} label="blacklisted" tone="emerald" />
        <Stat n={already} label="already" tone="slate" />
        {skipped > 0 && <Stat n={skipped} label="skipped" tone="amber" />}
        {failed > 0 && <Stat n={failed} label="failed" tone="rose" />}
      </div>

      {configErrors.length > 0 && (
        <div className="px-4 py-2.5 text-xs text-rose-700 bg-rose-50/60 border-b">
          {configErrors.length === 1 ? "Instance" : "Instances"} <span className="font-medium">{configErrors.join(", ")}</span> not configured (missing token) — those items are counted as failed. Deselect the instance and retry, or set its token.
        </div>
      )}
    </div>
  );
}

const TONE: Record<string, string> = {
  emerald: "text-emerald-700", slate: "text-slate-600", amber: "text-amber-700", rose: "text-rose-600",
};
function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`font-semibold tabular-nums ${TONE[tone]}`}>{n.toLocaleString()}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}
