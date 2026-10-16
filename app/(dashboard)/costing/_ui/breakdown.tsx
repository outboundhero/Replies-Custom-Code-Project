"use client";

import { ChevronRight, Info } from "lucide-react";
import type { BreakdownRow } from "@/lib/costing/types";
import { cn } from "@/lib/utils";
import { money, pct, toNumber, isZero, colorFor, categoryLabel, vendorLabel } from "./format";
import { Dot, Segmented } from "./parts";

export type Dim = "product" | "category" | "vendor" | "model" | "client" | "feature";
export const DIMS: Array<{ value: Dim; label: string }> = [
  { value: "product", label: "Product" }, { value: "category", label: "Category" }, { value: "vendor", label: "Vendor" },
  { value: "model", label: "AI model" }, { value: "client", label: "Client" }, { value: "feature", label: "Feature" },
];
const NOT_ALLOCATED = "Not allocated";

export function labelFor(dim: Dim, key: string, label: string): string {
  if (dim === "category") return categoryLabel(key);
  if (dim === "vendor") return vendorLabel(key);
  if (key === "unattributed") return "Unattributed";
  return label;
}

export function Breakdown({ dim, onDim, rows, total, currency, active, onPick }: {
  dim: Dim; onDim: (d: Dim) => void; rows: BreakdownRow[]; total: string; currency: string;
  active: string | null; onPick: (dim: Dim, key: string) => void;
}) {
  const order = rows.map((r) => r.key);
  const max = rows.reduce((m, r) => Math.max(m, Math.abs(toNumber(r.units))), 0) || 1;
  const onlyNotAllocated = (dim === "client" || dim === "feature") && rows.length > 0 && rows.every((r) => r.key === NOT_ALLOCATED);
  return (
    <div className="space-y-3">
      <Segmented value={dim} onChange={onDim} options={DIMS} className="flex-wrap" />
      {onlyNotAllocated && (
        <p className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" />
          No product splits its costs by {dim} yet. Products add this through each line item&apos;s allocations.
        </p>
      )}
      {!rows.length ? <p className="py-6 text-center text-sm text-muted-foreground">Nothing in this range.</p> : (
        <ul className="-mx-2">
          {rows.map((r) => {
            const clickable = r.key !== NOT_ALLOCATED && r.key !== "—";
            const isOn = active === r.key;
            return (
              <li key={r.key}>
                <button type="button" disabled={!clickable} onClick={() => clickable && onPick(dim, r.key)}
                  title={clickable ? (isOn ? "Show everything again" : `Show only ${labelFor(dim, r.key, r.label)}`) : undefined}
                  className={cn("group block w-full rounded-lg px-2 py-2.5 text-left transition-colors",
                    clickable && "hover:bg-muted/60", isOn && "bg-primary/[0.06] ring-1 ring-inset ring-primary/20")}>
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2.5 text-sm">
                      <Dot color={r.key === NOT_ALLOCATED ? "#cbd5e1" : colorFor(r.key, order)} className="translate-y-[-1px]" />
                      <span className={cn("truncate font-medium", r.key === NOT_ALLOCATED && "font-normal text-muted-foreground")}>{labelFor(dim, r.key, r.label)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="text-sm font-semibold tabular-nums">{money(r.units, currency)}</span>
                      <ChevronRight className={cn("size-3.5 text-muted-foreground/0 transition-colors", clickable && "group-hover:text-muted-foreground")} />
                    </span>
                  </span>
                  <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full rounded-full transition-all" style={{ width: `${Math.max(1, (Math.abs(toNumber(r.units)) / max) * 100)}%`, background: r.key === NOT_ALLOCATED ? "#cbd5e1" : colorFor(r.key, order) }} />
                  </span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                    <span>{pct(r.units, total)} of spend</span>
                    <span aria-hidden>·</span>
                    <span>{r.items} item{r.items === 1 ? "" : "s"}</span>
                    {!isZero(r.pending) && <><span aria-hidden>·</span><span className="text-amber-700 dark:text-amber-300" title="Not final yet — the provider may still revise it">{money(r.pending, currency)} pending</span></>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
