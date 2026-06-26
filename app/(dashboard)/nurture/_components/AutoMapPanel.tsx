"use client";

/**
 * Live progress panel for "Auto-map campaigns" (Automation tab). Renders one row
 * per client as the driver loop completes it — which campaigns got mapped, what
 * was already mapped, what's missing, what's ambiguous — with a sticky header
 * (progress bar + running tallies) and a final summary. Draft-only: nothing sends.
 */
import { useMemo } from "react";
import { Sparkles, Loader2, Check, AlertTriangle, X, Square, CircleSlash } from "lucide-react";
import type { Esp } from "@/lib/nurture/esp";

export interface AutoMapAddition {
  instance: string;
  lane: "b2b" | "b2c";
  esp: Esp;
  campaign_id: number;
  campaign_name: string;
}
export interface AutoMapReport {
  tag: string;
  added: AutoMapAddition[];
  skippedAlreadyMapped: Array<{ instance: string; esp: Esp }>;
  noCandidate: Array<{ instance: string; lane: "b2b" | "b2c"; esp: Esp }>;
  ambiguous: Array<{ instance: string; esp: Esp; chosen: string; choices: string[] }>;
  noGroup?: boolean;
}
export interface AutoMapResultItem {
  report: AutoMapReport;
  error?: string;
}

const ESP_SHORT: Record<Esp, string> = { google: "G", outlook: "O", segs: "S" };

export default function AutoMapPanel({
  dryRun,
  running,
  total,
  current,
  results,
  onStop,
  onClose,
}: {
  dryRun: boolean;
  running: boolean;
  total: number;
  current: string | null;
  results: AutoMapResultItem[];
  onStop: () => void;
  onClose: () => void;
}) {
  const done = results.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const tally = useMemo(() => {
    let mapped = 0, fully = 0, gaps = 0, review = 0;
    for (const { report, error } of results) {
      if (error) { review++; continue; }
      mapped += report.added.length;
      gaps += report.noCandidate.length;
      review += report.ambiguous.length + (report.noGroup ? 1 : 0);
      if (!report.noGroup && report.noCandidate.length === 0) fully++;
    }
    return { mapped, fully, gaps, review };
  }, [results]);

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      {/* ── Sticky header ── */}
      <div className="sticky top-0 z-10 bg-card">
        <div className="flex items-center gap-3 px-4 py-3 border-b">
          <span className={`grid place-items-center size-8 rounded-lg ${dryRun ? "bg-violet-100 text-violet-700" : "bg-emerald-100 text-emerald-700"}`}>
            <Sparkles className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold truncate">
                {running ? "Auto-mapping nurture campaigns…" : "Auto-map complete"}
              </p>
              {dryRun && (
                <span className="text-[10px] font-semibold rounded-full px-2 py-0.5 bg-violet-100 text-violet-700">PREVIEW</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
              {done} / {total} client{total === 1 ? "" : "s"}
              {current && running ? <> · mapping <span className="font-mono font-medium text-foreground">{current}</span></> : null}
            </p>
          </div>

          {/* Running tallies */}
          <div className="ml-auto hidden sm:flex items-center gap-3 text-xs">
            <Stat n={tally.mapped} label="mapped" tone="emerald" />
            <Stat n={tally.fully} label="clients" tone="slate" />
            <Stat n={tally.gaps} label="gaps" tone="rose" />
            <Stat n={tally.review} label="review" tone="amber" />
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
        {/* Progress bar */}
        <div className="h-1 bg-muted">
          <div
            className={`h-full transition-all duration-300 ${dryRun ? "bg-violet-500" : "bg-emerald-500"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* ── Live feed (newest first) ── */}
      <div className="max-h-[58vh] overflow-auto divide-y">
        {running && current && (
          <div className="flex items-center gap-3 px-4 py-2.5 bg-muted/20">
            <Loader2 className="size-4 text-muted-foreground animate-spin shrink-0" />
            <span className="w-24 shrink-0 font-mono text-sm font-semibold">{current}</span>
            <span className="text-xs text-muted-foreground">Resolving canonical campaigns…</span>
          </div>
        )}
        {[...results].reverse().map((item, i) => (
          <ClientRow key={`${item.report.tag}-${results.length - i}`} item={item} />
        ))}
        {!running && results.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">No active clients needed mapping.</div>
        )}
      </div>

      {/* ── Footer summary ── */}
      {!running && results.length > 0 && (
        <div className="px-4 py-3 border-t bg-muted/20 text-xs text-muted-foreground">
          {dryRun ? (
            <>Preview only — <span className="font-medium text-foreground">{tally.mapped}</span> campaign{tally.mapped === 1 ? "" : "s"} would be mapped across <span className="font-medium text-foreground">{done}</span> client{done === 1 ? "" : "s"}. Nothing was written.</>
          ) : (
            <>Mapped <span className="font-medium text-emerald-700">{tally.mapped}</span> campaign{tally.mapped === 1 ? "" : "s"} across <span className="font-medium text-foreground">{done}</span> client{done === 1 ? "" : "s"} · <span className="text-rose-600">{tally.gaps}</span> gap{tally.gaps === 1 ? "" : "s"} · <span className="text-amber-700">{tally.review}</span> need review. Saved as <span className="font-medium text-foreground">drafts</span> — confirm each client to enable sending.</>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: "emerald" | "slate" | "rose" | "amber" }) {
  const color = {
    emerald: "text-emerald-700",
    slate: "text-slate-600",
    rose: "text-rose-600",
    amber: "text-amber-700",
  }[tone];
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`font-semibold tabular-nums ${color}`}>{n}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function Chip({ tone, title, children }: { tone: "emerald" | "slate" | "rose" | "amber"; title?: string; children: React.ReactNode }) {
  const cls = {
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    slate: "bg-slate-100 text-slate-600 ring-slate-200",
    rose: "bg-rose-50 text-rose-600 ring-rose-200",
    amber: "bg-amber-50 text-amber-700 ring-amber-200",
  }[tone];
  return (
    <span title={title} className={`inline-flex items-center gap-1 max-w-full rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${cls}`}>
      {children}
    </span>
  );
}

function ClientRow({ item }: { item: AutoMapResultItem }) {
  const { report, error } = item;
  const nothing = !error && !report.noGroup && report.added.length === 0;

  // Lead status icon for the row.
  const icon = error || report.noGroup
    ? <CircleSlash className="size-4 text-slate-400 shrink-0 mt-0.5" />
    : report.added.length > 0
      ? <Check className="size-4 text-emerald-600 shrink-0 mt-0.5" />
      : report.noCandidate.length > 0
        ? <AlertTriangle className="size-4 text-rose-500 shrink-0 mt-0.5" />
        : <Check className="size-4 text-slate-400 shrink-0 mt-0.5" />;

  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      {icon}
      <span className="w-24 shrink-0 font-mono text-sm font-semibold truncate" title={report.tag}>{report.tag}</span>
      <div className="flex-1 flex flex-wrap items-center gap-1.5 min-w-0">
        {error ? (
          <Chip tone="rose" title={error}>error: {error.slice(0, 60)}</Chip>
        ) : report.noGroup ? (
          <Chip tone="slate">no group — sync the group sheet</Chip>
        ) : (
          <>
            {report.added.map((a) => (
              <Chip key={`${a.instance}-${a.esp}`} tone="emerald" title={a.campaign_name}>
                <span className="font-semibold">{a.lane.toUpperCase()}·{ESP_SHORT[a.esp]}</span>
                <span className="opacity-50">→</span>
                <span className="truncate max-w-[16rem]">{a.campaign_name}</span>
              </Chip>
            ))}
            {report.skippedAlreadyMapped.length > 0 && (
              <Chip tone="slate" title={report.skippedAlreadyMapped.map((s) => `${s.instance} · ${s.esp}`).join("\n")}>
                {report.skippedAlreadyMapped.length} already mapped
              </Chip>
            )}
            {report.noCandidate.map((m) => (
              <Chip key={`nc-${m.instance}-${m.esp}`} tone="rose" title={`No canonical campaign found in ${m.instance}`}>
                {m.lane.toUpperCase()}·{ESP_SHORT[m.esp]} missing
              </Chip>
            ))}
            {report.ambiguous.map((a) => (
              <Chip key={`amb-${a.instance}-${a.esp}`} tone="amber" title={`Chose: ${a.chosen}\n\nCandidates:\n${a.choices.join("\n")}`}>
                {ESP_SHORT[a.esp]} ambiguous ({a.choices.length})
              </Chip>
            ))}
            {nothing && report.noCandidate.length === 0 && (
              <span className="text-xs text-muted-foreground">already fully mapped</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
