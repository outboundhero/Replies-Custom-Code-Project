"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function Section({ icon, title, sub, action, children, className, bodyClassName }: {
  icon: ReactNode; title: string; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string;
}) {
  return (
    <section className={cn("min-w-0 overflow-hidden rounded-2xl border bg-card shadow-xs", className)}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground/70">{icon}</div>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold leading-tight">{title}</h3>
            {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
          </div>
        </div>
        {action}
      </header>
      <div className={cn("px-5 py-4", bodyClassName)}>{children}</div>
    </section>
  );
}

type Tone = "green" | "amber" | "red" | "muted" | "violet" | "sky" | "indigo";
export function Chip({ tone = "muted", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  const cls = {
    green: "bg-emerald-500/10 text-emerald-700 ring-emerald-600/15 dark:text-emerald-300",
    amber: "bg-amber-500/10 text-amber-800 ring-amber-600/20 dark:text-amber-300",
    red: "bg-destructive/10 text-destructive ring-destructive/20",
    muted: "bg-muted text-muted-foreground ring-border",
    violet: "bg-violet-500/10 text-violet-700 ring-violet-600/15 dark:text-violet-300",
    sky: "bg-sky-500/10 text-sky-700 ring-sky-600/15 dark:text-sky-300",
    indigo: "bg-indigo-500/10 text-indigo-700 ring-indigo-600/15 dark:text-indigo-300",
  }[tone];
  return <span title={title} className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", cls, className)}>{children}</span>;
}

export const Dot = ({ color, className }: { color: string; className?: string }) =>
  <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-[3px]", className)} style={{ background: color }} />;

export function Empty({ icon, title, children, action, className }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      <div className="grid size-12 place-items-center rounded-2xl border bg-background text-muted-foreground shadow-xs">{icon}</div>
      <p className="mt-4 text-sm font-semibold">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** A compact filter select with an "All …" choice. */
export function FilterSelect({ label, value, onChange, options, allLabel, className }: {
  label: string; value: string | null; onChange: (v: string | null) => void;
  options: Array<{ value: string; label: string }>; allLabel: string; className?: string;
}) {
  const ALL = "__all__";
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? null : v)} disabled={!options.length && !value}>
      <SelectTrigger aria-label={label} className={cn("h-8 min-w-0 gap-1.5 bg-background text-xs", value && "border-primary/40 bg-primary/[0.04] font-medium", className)}>
        <span className="shrink-0 text-muted-foreground">{label}:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** Segmented control. */
export function Segmented<T extends string>({ value, onChange, options, className, size = "sm" }: {
  value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>; className?: string; size?: "sm" | "xs";
}) {
  return (
    <div role="radiogroup" className={cn("inline-flex items-center rounded-lg border bg-muted/50 p-0.5", className)}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md font-medium transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
            size === "sm" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[11px]",
            value === o.value ? "bg-background text-foreground shadow-xs ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
          )}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
