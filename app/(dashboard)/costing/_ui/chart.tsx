"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BarChart3 } from "lucide-react";
import type { Period } from "@/lib/costing/types";
import { money, toNumber, colorFor } from "./format";
import { Dot, Empty } from "./parts";

const MAX_SERIES = 8;
const OTHER = "__other__";

export function SpendChart({ periods, rows, keys, currency, labelOf }: {
  periods: Period[];
  rows: Array<Record<string, string>>;
  keys: Array<{ key: string; label: string }>;
  currency: string;
  labelOf?: (k: string) => string;
}) {
  const shown = keys.slice(0, MAX_SERIES);
  const rest = keys.slice(MAX_SERIES).map((k) => k.key);
  const order = keys.map((k) => k.key);
  const series = [...shown.map((k) => ({ ...k, color: colorFor(k.key, order) })), ...(rest.length ? [{ key: OTHER, label: `${rest.length} more`, color: "#cbd5e1" }] : [])];

  // Exact units per period and key (for the tooltip), numbers only for bar heights.
  const data = useMemo(() => periods.map((p, i) => {
    const r = rows[i] ?? {};
    const exact: Record<string, bigint> = {};
    for (const k of shown) if (r[k.key]) exact[k.key] = BigInt(r[k.key]);
    if (rest.length) exact[OTHER] = rest.reduce((s, k) => s + (r[k] ? BigInt(r[k]) : BigInt(0)), BigInt(0));
    const total = Object.values(exact).reduce((s, v) => s + v, BigInt(0));
    return { label: p.label, range: p.from === p.to ? p.from : `${p.from} → ${p.to}`, exact, total, ...Object.fromEntries(Object.entries(exact).map(([k, v]) => [k, toNumber(v)])) };
  }), [periods, rows, shown, rest]);

  if (!data.some((d) => d.total !== BigInt(0))) {
    return <Empty icon={<BarChart3 className="size-5" />} title="No spend in this range">Pick a longer range, or clear a filter.</Empty>;
  }
  const compact = (v: number) => {
    const sym = currency === "USD" ? "$" : currency === "INR" ? "₹" : "";
    const a = Math.abs(v);
    const s = a >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : `${+v.toFixed(2)}`;
    return sym ? (s.startsWith("-") ? `-${sym}${s.slice(1)}` : `${sym}${s}`) : s;
  };

  return (
    <div className="space-y-3">
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }} barCategoryGap={data.length > 40 ? 1 : "18%"}>
            <CartesianGrid vertical={false} stroke="#e5e7eb" strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#64748b" }} interval="preserveStartEnd" minTickGap={12} />
            <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={compact} width={56} />
            <Tooltip cursor={{ fill: "rgba(100,116,139,0.08)" }} content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as (typeof data)[number];
              const parts = series.filter((s) => d.exact[s.key] && d.exact[s.key] !== BigInt(0));
              return (
                <div className="min-w-56 rounded-xl border bg-popover/95 px-3.5 py-3 text-xs shadow-lg backdrop-blur">
                  <div className="flex items-baseline justify-between gap-6">
                    <span className="font-semibold">{d.label}</span>
                    <span className="font-semibold tabular-nums">{money(d.total, currency)}</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">{d.range} · UTC</div>
                  {parts.length > 0 && <div className="mt-2.5 space-y-1.5 border-t pt-2.5">
                    {[...parts].reverse().map((s) => (
                      <div key={s.key} className="flex items-center justify-between gap-6">
                        <span className="flex min-w-0 items-center gap-2"><Dot color={s.color} /><span className="truncate">{labelOf ? labelOf(s.label) : s.label}</span></span>
                        <span className="tabular-nums text-muted-foreground">{money(d.exact[s.key], currency)}</span>
                      </div>
                    ))}
                  </div>}
                </div>
              );
            }} />
            {series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} stackId="spend" fill={s.color} radius={i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} maxBarSize={56} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Dot color={s.color} />{labelOf && s.key !== OTHER ? labelOf(s.label) : s.label}</span>
        ))}
      </div>
    </div>
  );
}
