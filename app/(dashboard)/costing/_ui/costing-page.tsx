"use client";

/**
 * Costing — what every product costs to run, from each product's /api/costing feed
 * (docs/costing-feed-spec.md). Exact figures, per currency, days in UTC. Admin-only.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, CalendarRange, CircleDollarSign, Clock3, Layers, Loader2, PieChart, Plug, Plus,
  ReceiptText, RefreshCw, Trophy, Wallet, X,
} from "lucide-react";
import type { CostingDashboard, Group, ItemView, StatusFilter } from "@/lib/costing/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { money, pct, toNumber, isZero, ago, rangeLabel, categoryLabel, vendorLabel } from "./format";
import { Empty, FilterSelect, Section, Segmented } from "./parts";
import { SpendChart } from "./chart";
import { Breakdown, type Dim } from "./breakdown";
import { ItemsTable } from "./items";
import { ConnectDialog, ProductGrid } from "./products";
import { ManualCostDialog } from "./manual";

type Preset = "this_month" | "last_month" | "7d" | "30d" | "90d" | "this_year" | "custom";
const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: "this_month", label: "This month" }, { value: "last_month", label: "Last month" }, { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" }, { value: "90d", label: "90 days" }, { value: "this_year", label: "This year" }, { value: "custom", label: "Custom" },
];
const DAY = 86_400_000;
const utc = (t: number) => new Date(t).toISOString().slice(0, 10);
function presetRange(p: Preset, todayIso: string): { from: string; to: string } {
  const t = Date.parse(`${todayIso}T00:00:00Z`);
  const y = Number(todayIso.slice(0, 4)), m = Number(todayIso.slice(5, 7));
  switch (p) {
    case "last_month": return { from: utc(Date.UTC(y, m - 2, 1)), to: utc(Date.UTC(y, m - 1, 0)) };
    case "7d": return { from: utc(t - 6 * DAY), to: todayIso };
    case "30d": return { from: utc(t - 29 * DAY), to: todayIso };
    case "90d": return { from: utc(t - 89 * DAY), to: todayIso };
    case "this_year": return { from: `${y}-01-01`, to: todayIso };
    default: return { from: `${todayIso.slice(0, 7)}-01`, to: todayIso };
  }
}
const defaultGroup = (from: string, to: string): Group => {
  const days = (Date.parse(to) - Date.parse(from)) / DAY + 1;
  return days <= 45 ? "day" : days <= 120 ? "week" : "month";
};

interface State {
  preset: Preset; from: string; to: string; group: Group; status: StatusFilter; currency: string | null;
  product: string | null; category: string | null; vendor: string | null; model: string | null; client: string | null; feature: string | null;
}
const FILTER_KEYS = ["product", "category", "vendor", "model", "client", "feature"] as const;

function fromParams(sp: URLSearchParams, todayIso: string): State {
  const preset = (PRESETS.some((p) => p.value === sp.get("range")) ? sp.get("range") : "this_month") as Preset;
  const r = preset === "custom" && sp.get("from") && sp.get("to") ? { from: sp.get("from")!, to: sp.get("to")! } : presetRange(preset === "custom" ? "this_month" : preset, todayIso);
  const g = sp.get("group");
  return {
    preset, ...r, group: g === "day" || g === "week" || g === "month" ? g : defaultGroup(r.from, r.to),
    status: sp.get("status") === "final" || sp.get("status") === "pending" ? (sp.get("status") as StatusFilter) : "all",
    currency: sp.get("currency"),
    ...Object.fromEntries(FILTER_KEYS.map((k) => [k, sp.get(k)])) as Pick<State, (typeof FILTER_KEYS)[number]>,
  };
}
function toParams(s: State): string {
  const p = new URLSearchParams();
  if (s.preset !== "this_month") p.set("range", s.preset);
  if (s.preset === "custom") { p.set("from", s.from); p.set("to", s.to); }
  if (s.group !== defaultGroup(s.from, s.to)) p.set("group", s.group);
  if (s.status !== "all") p.set("status", s.status);
  if (s.currency) p.set("currency", s.currency);
  for (const k of FILTER_KEYS) if (s[k]) p.set(k, s[k]!);
  return p.toString();
}

export function CostingPage({ todayIso }: { todayIso: string }) {
  const sp = useSearchParams();
  const router = useRouter();
  const [s, setS] = useState<State>(() => fromParams(new URLSearchParams(sp.toString()), todayIso));
  const [data, setData] = useState<CostingDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [chartBy, setChartBy] = useState<"product" | "category">("product");
  const [dim, setDim] = useState<Dim>("product");
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [connect, setConnect] = useState(false);
  const [manual, setManual] = useState<{ open: boolean; item: ItemView | null }>({ open: false, item: null });
  const [deleting, setDeleting] = useState<ItemView | null>(null);
  const [customDraft, setCustomDraft] = useState({ from: s.from, to: s.to });

  const query = toParams(s);
  useEffect(() => { router.replace(query ? `/costing?${query}` : "/costing", { scroll: false }); }, [query, router]);
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ from: s.from, to: s.to, group: s.group, status: s.status });
    if (s.currency) q.set("currency", s.currency);
    for (const k of FILTER_KEYS) if (s[k]) q.set(k, s[k]!);
    fetch(`/api/costing/dashboard?${q}`, { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 401) { window.location.href = "/login"; return; }
        const j = await r.json().catch(() => null);
        if (!live) return;
        if (!r.ok || !j || j.error) { setError(j?.error ?? `Couldn't load costs (${r.status}).`); setLoading(false); return; }
        setData(j as CostingDashboard); setError(null); setLoading(false);
      })
      .catch((e) => { if (live) { setError((e as Error).message); setLoading(false); } });
    return () => { live = false; };
  }, [s, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  const update = (patch: Partial<State>) => { setLoading(true); setS((x) => ({ ...x, ...patch })); };
  const pickPreset = (p: Preset) => {
    if (p === "custom") { setCustomDraft({ from: s.from, to: s.to }); update({ preset: "custom" }); return; }
    const r = presetRange(p, todayIso);
    update({ preset: p, ...r, group: defaultGroup(r.from, r.to) });
  };
  const setFilter = (k: (typeof FILTER_KEYS)[number], v: string | null) => {
    const patch: Partial<State> = { [k]: v };
    if (k === "client" && v) patch.feature = null;
    if (k === "feature" && v) patch.client = null;
    update(patch);
  };
  const activeFilters = FILTER_KEYS.filter((k) => s[k]);

  async function refresh(pid?: string) {
    setRefreshing(pid ?? "all");
    const r = await fetch("/api/costing/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pid ? { pid } : {}) });
    const j = await r.json().catch(() => ({}));
    setRefreshing(null);
    const results = (j.results ?? []) as Array<{ name: string; ok: boolean; skipped?: string; error?: string; added?: number; changed?: number; removed?: number }>;
    const real = results.filter((x) => !x.skipped);
    if (!real.length) toast.info("No products to refresh yet — connect one first.");
    else if (real.every((x) => x.ok)) {
      const sum = (k: "added" | "changed" | "removed") => real.reduce((n, x) => n + (x[k] ?? 0), 0);
      toast.success(`${real.length === 1 ? real[0].name : `${real.length} products`} refreshed — ${sum("added")} new, ${sum("changed")} changed${sum("removed") ? `, ${sum("removed")} no longer reported` : ""}.`);
    } else toast.error(real.filter((x) => !x.ok).map((x) => `${x.name}: ${x.error}`).join(" · "));
    reload();
  }

  async function removeManual(it: ItemView) {
    const r = await fetch("/api/costing/manual", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", id: it.id }) });
    const j = await r.json().catch(() => ({}));
    setDeleting(null);
    if (j.ok) { toast.success("Cost deleted."); reload(); } else toast.error(j.error ?? "Couldn't delete it.");
  }

  const cur = data?.currency ?? null;
  const now = data ? Date.parse(data.generatedAt) : 0;
  const feeds = data?.products.filter((p) => p.kind === "feed") ?? [];
  const hasAnything = !!data && (feeds.length > 0 || data.products.some((p) => p.stored_items > 0));

  // Biggest period, from the exact series.
  const biggest = useMemo(() => {
    if (!data || !cur) return null;
    let best: { label: string; units: bigint } | null = null;
    data.series.byProduct.forEach((row, i) => {
      const t = Object.entries(row).filter(([k]) => k !== "period").reduce((sum, [, v]) => sum + BigInt(v), BigInt(0));
      if (t !== BigInt(0) && (!best || t > best.units)) best = { label: data.periods[i].label, units: t };
    });
    return best as { label: string; units: bigint } | null;
  }, [data, cur]);

  const optionLabel = (k: (typeof FILTER_KEYS)[number], v: string) =>
    k === "product" ? data?.options.products.find((p) => p.key === v)?.label ?? v : k === "category" ? categoryLabel(v) : k === "vendor" ? vendorLabel(v) : v;
  const filterName: Record<(typeof FILTER_KEYS)[number], string> = { product: "Product", category: "Category", vendor: "Vendor", model: "AI model", client: "Client", feature: "Feature" };
  const groupWord = s.group === "day" ? "day" : s.group === "week" ? "week" : "month";

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 2xl:max-w-[1600px]">
      {/* ── Header + controls ─────────────────────────────────────── */}
      <section className="relative overflow-hidden rounded-2xl border bg-card shadow-xs">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-36 bg-gradient-to-br from-indigo-500/[0.08] via-sky-500/[0.04] to-transparent" />
        <div className="relative flex flex-wrap items-start justify-between gap-4 px-6 pb-5 pt-6">
          <div className="flex min-w-[18rem] flex-1 items-center gap-4">
            <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-indigo-600 to-sky-600 text-white shadow-sm ring-1 ring-black/5"><Wallet className="size-5" /></div>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight">Costing</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">What every product costs to run — exact figures from each product&apos;s billing. Days are UTC.</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {data?.lastRefreshedAt && <span className="mr-1 hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex"><Clock3 className="size-3.5" />Updated {ago(data.lastRefreshedAt, now)}</span>}
            <Button variant="outline" className="gap-1.5" onClick={() => setManual({ open: true, item: null })}><Plus className="size-4" />Add a cost</Button>
            <Button variant="outline" className="gap-1.5" disabled={!!refreshing || !feeds.some((p) => p.enabled)} onClick={() => refresh()}>
              {refreshing === "all" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}Refresh all
            </Button>
            <Button className="gap-1.5" onClick={() => setConnect(true)}><Plug className="size-4" />Connect a product</Button>
          </div>
        </div>

        <div className="relative space-y-3 border-t bg-muted/20 px-6 py-3.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
            <Segmented value={s.preset} onChange={pickPreset} options={PRESETS} />
            {s.preset === "custom" && (
              <form className="flex items-center gap-1.5" onSubmit={(e) => {
                e.preventDefault();
                const { from, to } = customDraft;
                if (!from || !to || from > to) { toast.error("Choose a start date on or before the end date."); return; }
                update({ from, to, group: defaultGroup(from, to) });
              }}>
                <Input type="date" value={customDraft.from} max={customDraft.to || undefined} onChange={(e) => setCustomDraft((d) => ({ ...d, from: e.target.value }))} className="h-8 w-[9.5rem] text-xs" aria-label="From" />
                <span className="text-xs text-muted-foreground">to</span>
                <Input type="date" value={customDraft.to} min={customDraft.from || undefined} onChange={(e) => setCustomDraft((d) => ({ ...d, to: e.target.value }))} className="h-8 w-[9.5rem] text-xs" aria-label="To" />
                <Button type="submit" size="sm" variant="secondary" className="h-8 text-xs">Apply</Button>
              </form>
            )}
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><CalendarRange className="size-3.5" />{rangeLabel(s.from, s.to)}</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Segmented value={s.status} onChange={(v) => update({ status: v })} options={[{ value: "all", label: "All" }, { value: "final", label: "Final" }, { value: "pending", label: "Pending" }]} />
              <Segmented value={s.group} onChange={(g) => update({ group: g })} options={[{ value: "day", label: "Daily" }, { value: "week", label: "Weekly" }, { value: "month", label: "Monthly" }]} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect label="Product" value={s.product} onChange={(v) => setFilter("product", v)} allLabel="All products" options={(data?.options.products ?? []).map((p) => ({ value: p.key, label: p.label }))} className="w-auto max-w-56" />
            <FilterSelect label="Category" value={s.category} onChange={(v) => setFilter("category", v)} allLabel="All categories" options={(data?.options.categories ?? []).map((c) => ({ value: c, label: categoryLabel(c) }))} className="w-auto max-w-56" />
            <FilterSelect label="Vendor" value={s.vendor} onChange={(v) => setFilter("vendor", v)} allLabel="All vendors" options={(data?.options.vendors ?? []).map((v) => ({ value: v, label: vendorLabel(v) }))} className="w-auto max-w-56" />
            <FilterSelect label="AI model" value={s.model} onChange={(v) => setFilter("model", v)} allLabel="All models" options={(data?.options.models ?? []).map((m) => ({ value: m, label: m }))} className="w-auto max-w-56" />
            <FilterSelect label="Client" value={s.client} onChange={(v) => setFilter("client", v)} allLabel="All clients" options={(data?.options.clients ?? []).map((c) => ({ value: c, label: c === "unattributed" ? "Unattributed" : c }))} className="w-auto max-w-56" />
            <FilterSelect label="Feature" value={s.feature} onChange={(v) => setFilter("feature", v)} allLabel="All features" options={(data?.options.features ?? []).map((c) => ({ value: c, label: c }))} className="w-auto max-w-56" />
            {data && data.currencies.length > 1 && (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Currency</span>
                <Segmented value={cur ?? ""} onChange={(c) => update({ currency: c })} options={data.currencies.map((c) => ({ value: c.currency, label: c.currency }))} />
              </div>
            )}
          </div>
          {activeFilters.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Showing only</span>
              {activeFilters.map((k) => (
                <span key={k} className="inline-flex items-center gap-1 rounded-full bg-primary/[0.07] py-0.5 pl-2.5 pr-1 font-medium text-primary ring-1 ring-inset ring-primary/15">
                  {filterName[k]}: {optionLabel(k, s[k]!)}
                  <button type="button" aria-label={`Remove ${filterName[k]} filter`} onClick={() => setFilter(k, null)} className="grid size-4 place-items-center rounded-full hover:bg-primary/15"><X className="size-3" /></button>
                </span>
              ))}
              <button type="button" onClick={() => update(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])) as Partial<State>)} className="ml-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Clear all</button>
            </div>
          )}
        </div>
      </section>

      {error && !data && <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-6 py-8 text-center text-sm text-destructive">{error}</div>}

      {!data && !error ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-28 animate-pulse rounded-2xl border bg-muted/30" />)}</div>
          <div className="grid gap-5 xl:grid-cols-5"><div className="h-96 animate-pulse rounded-2xl border bg-muted/30 xl:col-span-3" /><div className="h-96 animate-pulse rounded-2xl border bg-muted/30 xl:col-span-2" /></div>
        </div>
      ) : data && (
        <div className={cn("space-y-5 transition-opacity", loading && "pointer-events-none opacity-60")}>
          {/* ── Warnings ─────────────────────────────────────────── */}
          {data.warnings.length > 0 && (
            <div className="space-y-2">
              {data.warnings.map((w, i) => (
                <div key={i} className={cn("flex items-start gap-3 rounded-xl border px-4 py-3 text-sm", w.kind === "feed-error" ? "border-destructive/25 bg-destructive/[0.04]" : "border-amber-500/30 bg-amber-500/[0.06]")}>
                  <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", w.kind === "feed-error" ? "text-destructive" : "text-amber-600")} />
                  <div className="min-w-0">
                    <div className="font-medium">{w.title}</div>
                    <div className="mt-0.5 break-words text-xs text-muted-foreground">{w.detail}</div>
                  </div>
                  {w.kind !== "duplicate-invoice" && w.pids[0] && (
                    <Button size="sm" variant="outline" className="ml-auto h-7 shrink-0 gap-1.5 text-xs" disabled={!!refreshing} onClick={() => refresh(w.pids[0])}>
                      {refreshing === w.pids[0] ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}Retry
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {!hasAnything ? (
            <section className="rounded-2xl border border-dashed bg-card">
              <Empty icon={<Wallet className="size-5" />} title="No costs yet"
                action={<><Button className="gap-1.5" onClick={() => setConnect(true)}><Plug className="size-4" />Connect a product</Button><Button variant="outline" className="gap-1.5" onClick={() => setManual({ open: true, item: null })}><Plus className="size-4" />Add a cost by hand</Button></>}>
                Connect each product&apos;s costing feed — LeadSync, the lead database, the Maps scraper and the rest — and its exact costs show up here, day by day. Costs for tools no product reports can be added by hand.
              </Empty>
            </section>
          ) : (
            <>
              {/* ── Stat strip ───────────────────────────────────── */}
              <StatStrip data={data} biggest={biggest} groupWord={groupWord} />

              {/* ── Chart + breakdown ────────────────────────────── */}
              <div className="grid gap-5 xl:grid-cols-5">
                <Section className="xl:col-span-3" icon={<BarChart3 className="size-4" />} title="Spend over time"
                  sub={`By ${groupWord}${cur ? ` · ${cur}` : ""} · UTC`}
                  action={<Segmented size="xs" value={chartBy} onChange={setChartBy} options={[{ value: "product", label: "By product" }, { value: "category", label: "By category" }]} />}>
                  {cur ? (
                    <SpendChart periods={data.periods} currency={cur}
                      rows={chartBy === "product" ? data.series.byProduct : data.series.byCategory}
                      keys={chartBy === "product" ? data.seriesKeys.products : data.seriesKeys.categories}
                      labelOf={chartBy === "category" ? categoryLabel : undefined} />
                  ) : <Empty icon={<BarChart3 className="size-5" />} title="No spend in this range">Pick a longer range, or clear a filter.</Empty>}
                </Section>
                <Section className="xl:col-span-2" icon={<PieChart className="size-4" />} title="Where it goes" sub="Click a row to show only that">
                  {cur ? (
                    <Breakdown dim={dim} onDim={setDim} rows={data.breakdowns[dim]} total={data.totals?.all ?? "0"} currency={cur}
                      active={s[dim]} onPick={(d, k) => setFilter(d, s[d] === k ? null : k)} />
                  ) : <p className="py-10 text-center text-sm text-muted-foreground">Nothing to break down.</p>}
                </Section>
              </div>

              {/* ── Line items ───────────────────────────────────── */}
              <Section icon={<ReceiptText className="size-4" />} title="Line items" sub={`Every cost in ${rangeLabel(s.from, s.to)}${cur ? `, in ${cur}` : ""} — open one for its usage, split and invoice`}>
                {cur ? <ItemsTable items={data.items} truncated={data.itemsTruncated} currency={cur} filtered={activeFilters.length > 0 || s.status !== "all"}
                  onEdit={(it) => setManual({ open: true, item: it })} onDelete={(it) => setDeleting(it)} />
                  : <Empty icon={<ReceiptText className="size-5" />} title="No line items">{activeFilters.length || s.status !== "all" ? "Nothing matches these filters." : "Nothing was billed in this range."}</Empty>}
              </Section>
            </>
          )}

          {/* ── Products ───────────────────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2 px-1">
              <div>
                <h2 className="text-[15px] font-semibold">Products</h2>
                <p className="text-xs text-muted-foreground">Pulled every day at 05:40 UTC — the last 35 days each time, and any older figure until it&apos;s final. A product&apos;s first pull brings in the last 12 months.</p>
              </div>
            </div>
            <ProductGrid products={data.products} currency={cur} refreshing={refreshing} now={now}
              onRefresh={(pid) => refresh(pid)} onChanged={reload} onConnect={() => setConnect(true)} onAddManual={() => setManual({ open: true, item: null })} />
          </div>
        </div>
      )}

      <ConnectDialog open={connect} onClose={() => setConnect(false)} onConnected={() => { setConnect(false); reload(); }} />
      <ManualCostDialog open={manual.open} item={manual.item} onClose={() => setManual({ open: false, item: null })} onSaved={() => { setManual({ open: false, item: null }); reload(); }} />
      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this cost?</DialogTitle>
            <DialogDescription>{deleting ? `${vendorLabel(deleting.vendor)} · ${deleting.amount} ${deleting.currency} on ${deleting.date}. It's removed from every total; the history keeps a record.` : ""}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleting && removeManual(deleting)}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatStrip({ data, biggest, groupWord }: { data: CostingDashboard; biggest: { label: string; units: bigint } | null; groupWord: string }) {
  const cur = data.currency;
  const t = data.totals;
  const prev = data.previous;
  const top = data.breakdowns.product[0];
  let delta: { up: boolean; text: string } | null = null;
  if (t && prev && !isZero(prev.all)) {
    const a = toNumber(t.all), b = toNumber(prev.all);
    const p = ((a - b) / Math.abs(b)) * 100;
    delta = { up: p >= 0, text: `${Math.abs(p) >= 10 ? Math.abs(p).toFixed(0) : Math.abs(p).toFixed(1)}%` };
  }
  const other = data.currencies.filter((c) => c.currency !== cur);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Tile icon={<CircleDollarSign className="size-4" />} label="Total spend" accent>
        <div className="text-[28px] font-semibold leading-tight tracking-tight tabular-nums">{cur && t ? money(t.all, cur) : "—"}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {delta && prev ? (
            <span className={cn("inline-flex items-center gap-0.5 font-medium", delta.up ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400")} title={`Previous ${t?.days ?? ""} days: ${money(prev.all, cur!)}`}>
              {delta.up ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}{delta.text}
            </span>
          ) : null}
          <span>{prev && cur ? `vs ${money(prev.all, cur)} the ${t?.days} days before` : t ? `${t.items} line items` : "Nothing in this range"}</span>
        </div>
        {other.length > 0 && <div className="mt-1.5 text-[11px] text-muted-foreground">Also {other.map((c) => money(c.units, c.currency)).join(" · ")} — not converted</div>}
      </Tile>
      <Tile icon={<Layers className="size-4" />} label="Pending">
        <div className="text-[22px] font-semibold leading-tight tabular-nums">{cur && t ? money(t.pending, cur) : "—"}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {t && t.pendingItems ? `${t.pendingItems} item${t.pendingItems === 1 ? "" : "s"} the provider may still revise · final ${money(t.final, cur!)}` : t ? "Everything in this range is final" : "—"}
        </div>
      </Tile>
      <Tile icon={<Trophy className="size-4" />} label="Top product">
        {top && cur && t ? (
          <>
            <div className="truncate text-[17px] font-semibold leading-tight" title={top.label}>{top.label}</div>
            <div className="mt-1 text-xs text-muted-foreground"><span className="font-semibold text-foreground tabular-nums">{money(top.units, cur)}</span> · {pct(top.units, t.all)} of spend</div>
          </>
        ) : <div className="text-sm text-muted-foreground">—</div>}
      </Tile>
      <Tile icon={<CalendarRange className="size-4" />} label={`Biggest ${groupWord}`}>
        {biggest && cur ? (
          <>
            <div className="text-[17px] font-semibold leading-tight">{biggest.label}</div>
            <div className="mt-1 text-xs text-muted-foreground"><span className="font-semibold text-foreground tabular-nums">{money(biggest.units, cur)}</span>{t ? ` · ${pct(biggest.units.toString(), t.all)} of the range` : ""}</div>
          </>
        ) : <div className="text-sm text-muted-foreground">—</div>}
      </Tile>
    </div>
  );
}

function Tile({ icon, label, children, accent }: { icon: React.ReactNode; label: string; children: React.ReactNode; accent?: boolean }) {
  return (
    <div className={cn("relative min-w-0 overflow-hidden rounded-2xl border bg-card px-5 py-4 shadow-xs", accent && "border-indigo-500/20")}>
      {accent && <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-indigo-500/[0.06] to-transparent" />}
      <div className="relative">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"><span className="text-foreground/50">{icon}</span>{label}</div>
        <div className="mt-2">{children}</div>
      </div>
    </div>
  );
}

