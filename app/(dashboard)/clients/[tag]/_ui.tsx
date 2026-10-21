"use client";

/** Building blocks shared by the client page and its service-area screens. */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ChipTone = "green" | "amber" | "red" | "muted" | "violet" | "sky";
export function Chip({ tone, children, className }: { tone: ChipTone; children: ReactNode; className?: string }) {
  const cls = {
    green: "bg-emerald-500/10 text-emerald-700 ring-emerald-600/15 dark:text-emerald-400",
    amber: "bg-amber-500/10 text-amber-700 ring-amber-600/20 dark:text-amber-400",
    red: "bg-destructive/10 text-destructive ring-destructive/20",
    muted: "bg-muted text-muted-foreground ring-border",
    violet: "bg-violet-500/10 text-violet-700 ring-violet-600/15 dark:text-violet-300",
    sky: "bg-sky-500/10 text-sky-700 ring-sky-600/15 dark:text-sky-300",
  }[tone];
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", cls, className)}>{children}</span>;
}
export function Card({ icon, title, sub, action, children, className, bodyClassName }: { icon: ReactNode; title: string; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn("overflow-hidden rounded-2xl border bg-card shadow-xs", className)}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
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
