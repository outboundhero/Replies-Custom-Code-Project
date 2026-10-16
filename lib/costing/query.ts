/**
 * Builds the Costing dashboard from stored line items — exact sums (bigint, 1e-12 units) per
 * currency, never converted between currencies (spec §8). Days, weeks (Mon–Sun) and months are UTC.
 */
import { parseUnits } from "./decimal";
import { itemStats, itemsBetween, listProducts, type ProductRow, type StoredItem } from "./store";
import { addDays, daysBetween } from "./pull";
import type { BreakdownRow, CostingDashboard, CostingFilters, ItemView, Period, ProductCard, Warning } from "./types";

const ZERO = BigInt(0);
const NOT_ALLOCATED = "Not allocated";
const MAX_ITEMS = 3000;

type Alloc = { dimension: string; key: string; amount: string };
interface Row extends StoredItem { pname: string; ex: { usage?: unknown; subscription?: unknown; allocations?: Alloc[]; attributes?: unknown }; u: bigint }

function parseExtra(s: string | null): Row["ex"] {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
const allocUnits = (a: Alloc) => parseUnits(a.amount) ?? ZERO;

/** Monday of the UTC week a date falls in. */
const mondayOf = (d: string) => { const t = new Date(`${d}T00:00:00Z`); return addDays(d, -((t.getUTCDay() + 6) % 7)); };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

export function periodsFor(from: string, to: string, group: CostingFilters["group"]): Period[] {
  const out: Period[] = [];
  if (group === "day") {
    for (let d = from; d <= to; d = addDays(d, 1)) out.push({ key: d, label: short(d), from: d, to: d });
  } else if (group === "week") {
    for (let m = mondayOf(from); m <= to; m = addDays(m, 7)) {
      const s = m < from ? from : m, e = addDays(m, 6) > to ? to : addDays(m, 6);
      const label = s === e ? short(s) : s.slice(5, 7) === e.slice(5, 7) ? `${short(s)} – ${Number(e.slice(8, 10))}` : `${short(s)} – ${short(e)}`;
      out.push({ key: m, label, from: s, to: e });
    }
  } else {
    let y = Number(from.slice(0, 4)), mo = Number(from.slice(5, 7));
    for (;;) {
      const key = `${y}-${String(mo).padStart(2, "0")}`;
      if (`${key}-01` > to) break;
      const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
      out.push({ key, label: `${MONTHS[mo - 1]} ${y}`, from: `${key}-01` < from ? from : `${key}-01`, to: last > to ? to : last });
      mo++; if (mo > 12) { mo = 1; y++; }
    }
  }
  return out;
}
const periodKey = (d: string, group: CostingFilters["group"]) => (group === "day" ? d : group === "week" ? mondayOf(d) : d.slice(0, 7));

/** The amount that counts for this item under the client / feature filter (its share), else the whole item. */
function effective(r: Row, f: CostingFilters): bigint | null {
  const dim = f.client ? "client" : f.feature ? "feature" : null;
  if (!dim) return r.u;
  const want = (f.client ?? f.feature)!;
  const allocs = (r.ex.allocations ?? []).filter((a) => a.dimension === dim);
  if (want === NOT_ALLOCATED) return allocs.length ? null : r.u;
  const hit = allocs.find((a) => a.key === want);
  return hit ? allocUnits(hit) : null;
}

function matches(r: Row, f: CostingFilters): boolean {
  if (f.product && r.pid !== f.product) return false;
  if (f.category && r.category !== f.category) return false;
  if (f.vendor && r.vendor !== f.vendor) return false;
  if (f.model && (r.model ?? "") !== f.model) return false;
  if (f.status && f.status !== "all" && r.status !== f.status) return false;
  return true;
}

async function load(from: string, to: string, names: Map<string, string>): Promise<Row[]> {
  return (await itemsBetween(from, to)).map((i) => ({ ...i, pname: names.get(i.pid) ?? i.pid, ex: parseExtra(i.extra), u: BigInt(i.units) }));
}

export async function buildDashboard(f: CostingFilters): Promise<CostingDashboard> {
  const [products, stats] = await Promise.all([listProducts(), itemStats()]);
  const names = new Map(products.map((p) => [p.pid, p.name]));
  const rows = await load(f.from, f.to, names);

  // Filter options come from everything in the range, so any filter can be switched.
  const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b));
  const allocKeys = (dim: string) => uniq(rows.flatMap((r) => (r.ex.allocations ?? []).filter((a) => a.dimension === dim).map((a) => a.key)));
  const options = {
    products: products.filter((p) => p.kind === "manual" ? rows.some((r) => r.pid === p.pid) : true).map((p) => ({ key: p.pid, label: p.name })),
    categories: uniq(rows.map((r) => r.category)), vendors: uniq(rows.map((r) => r.vendor)), models: uniq(rows.map((r) => r.model)),
    clients: allocKeys("client"), features: allocKeys("feature"),
  };

  // Rows that pass the filters, with the amount that counts for each.
  const picked: Array<Row & { e: bigint }> = [];
  for (const r of rows) {
    if (!matches(r, f)) continue;
    const e = effective(r, f);
    if (e === null) continue;
    picked.push({ ...r, e });
  }

  // Per-currency totals; the dashboard shows one currency at a time (never converted).
  const byCur = new Map<string, { units: bigint; items: number }>();
  for (const r of picked) { const c = byCur.get(r.currency) ?? { units: ZERO, items: 0 }; c.units += r.e; c.items++; byCur.set(r.currency, c); }
  const currencies = [...byCur].map(([currency, v]) => ({ currency, units: v.units.toString(), items: v.items }))
    .sort((a, b) => (a.currency === "USD" ? -1 : b.currency === "USD" ? 1 : b.items - a.items));
  const currency = f.currency && byCur.has(f.currency) ? f.currency : currencies[0]?.currency ?? null;
  const inCur = picked.filter((r) => r.currency === currency);

  const days = daysBetween(f.from, f.to) + 1;
  let totals: CostingDashboard["totals"] = null;
  if (currency) {
    let all = ZERO, fin = ZERO, pen = ZERO, pendingItems = 0;
    for (const r of inCur) { all += r.e; if (r.status === "pending") { pen += r.e; pendingItems++; } else fin += r.e; }
    totals = { all: all.toString(), final: fin.toString(), pending: pen.toString(), items: inCur.length, pendingItems, days };
  }

  // The same length of time just before, for comparison.
  let previous: CostingDashboard["previous"] = null;
  if (currency) {
    const pTo = addDays(f.from, -1), pFrom = addDays(f.from, -days);
    let sum = ZERO;
    for (const r of await load(pFrom, pTo, names)) {
      if (r.currency !== currency || !matches(r, f)) continue;
      const e = effective(r, f);
      if (e !== null) sum += e;
    }
    previous = { all: sum.toString(), from: pFrom, to: pTo };
  }

  // Time series by product and by category.
  const periods = periodsFor(f.from, f.to, f.group);
  const idx = new Map(periods.map((p, i) => [p.key, i]));
  const byProduct = periods.map(() => new Map<string, bigint>());
  const byCategory = periods.map(() => new Map<string, bigint>());
  for (const r of inCur) {
    const i = idx.get(periodKey(r.date, f.group));
    if (i === undefined) continue;
    byProduct[i].set(r.pid, (byProduct[i].get(r.pid) ?? ZERO) + r.e);
    byCategory[i].set(r.category, (byCategory[i].get(r.category) ?? ZERO) + r.e);
  }
  const ser = (m: Array<Map<string, bigint>>) => periods.map((p, i) => ({ period: p.key, ...Object.fromEntries([...m[i]].map(([k, v]) => [k, v.toString()])) }));
  const rank = (m: Array<Map<string, bigint>>) => {
    const t = new Map<string, bigint>();
    for (const x of m) for (const [k, v] of x) t.set(k, (t.get(k) ?? ZERO) + v);
    return [...t].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).map(([k]) => k);
  };

  // Breakdowns.
  const breakdown = (keyOf: (r: Row & { e: bigint }) => Array<[string, bigint]>, label: (k: string) => string = (k) => k): BreakdownRow[] => {
    const m = new Map<string, { units: bigint; pending: bigint; items: number }>();
    for (const r of inCur) for (const [k, v] of keyOf(r)) {
      const x = m.get(k) ?? { units: ZERO, pending: ZERO, items: 0 };
      x.units += v; if (r.status === "pending") x.pending += v; x.items++;
      m.set(k, x);
    }
    return [...m].sort((a, b) => (b[1].units > a[1].units ? 1 : b[1].units < a[1].units ? -1 : 0))
      .map(([k, v]) => ({ key: k, label: label(k), units: v.units.toString(), pending: v.pending.toString(), items: v.items }));
  };
  const byDim = (dim: string) => (r: Row & { e: bigint }): Array<[string, bigint]> => {
    // Under a client/feature filter only that share is in view; otherwise split by the item's allocations.
    if ((dim === "client" && f.client) || (dim === "feature" && f.feature)) return [[(f.client ?? f.feature)!, r.e]];
    const a = (r.ex.allocations ?? []).filter((x) => x.dimension === dim);
    if (!a.length) return [[NOT_ALLOCATED, r.e]];
    if (f.client || f.feature) return [[NOT_ALLOCATED, r.e]]; // a share of one dimension can't be split by another
    return a.map((x) => [x.key, allocUnits(x)]);
  };
  const breakdowns = {
    product: breakdown((r) => [[r.pid, r.e]], (k) => names.get(k) ?? k),
    category: breakdown((r) => [[r.category, r.e]]),
    vendor: breakdown((r) => [[r.vendor, r.e]]),
    model: breakdown((r) => [[r.model ?? "—", r.e]]),
    client: breakdown(byDim("client")),
    feature: breakdown(byDim("feature")),
  };

  // Line items.
  const sorted = [...inCur].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.e > a.e ? 1 : b.e < a.e ? -1 : 0));
  const items: ItemView[] = sorted.slice(0, MAX_ITEMS).map((r) => ({
    pid: r.pid, product: r.pname, id: r.item_id, date: r.date, category: r.category, vendor: r.vendor, service: r.service, model: r.model,
    description: r.description, billing_type: r.billing_type, amount: r.amount, units: r.e.toString(), full_units: r.units, currency: r.currency,
    source: r.source, status: r.status === "pending" ? "pending" : "final", invoice_id: r.invoice_id, invoice_url: r.invoice_url,
    usage: Array.isArray(r.ex.usage) ? (r.ex.usage as ItemView["usage"]) : null,
    subscription: r.ex.subscription && typeof r.ex.subscription === "object" ? (r.ex.subscription as ItemView["subscription"]) : null,
    allocations: Array.isArray(r.ex.allocations) ? r.ex.allocations : null,
    attributes: r.ex.attributes && typeof r.ex.attributes === "object" ? (r.ex.attributes as ItemView["attributes"]) : null,
    updated_at: r.updated_at,
  }));

  // Products.
  const rangeByPid = new Map<string, { units: bigint; items: number }>();
  for (const r of inCur) { const x = rangeByPid.get(r.pid) ?? { units: ZERO, items: 0 }; x.units += r.e; x.items++; rangeByPid.set(r.pid, x); }
  const health = (p: ProductRow): ProductCard["health"] =>
    p.kind === "manual" ? "manual" : !p.enabled ? "paused" : p.last_error && (!p.last_ok_at || (p.last_error_at ?? "") > p.last_ok_at) ? "error" : p.last_ok_at ? "ok" : "never";
  const cards: ProductCard[] = products.map((p) => {
    const st = stats.get(p.pid);
    const rr = rangeByPid.get(p.pid);
    return {
      pid: p.pid, name: p.name, slug: p.slug, kind: p.kind, enabled: p.enabled, base_url: p.base_url, key_hint: p.key_hint,
      environment: p.environment, notes: p.notes, health: health(p), last_ok_at: p.last_ok_at, last_pull_at: p.last_pull_at,
      last_error: p.last_error, last_error_at: p.last_error_at, stored_items: st?.items ?? 0, first_date: st?.first ?? null, last_date: st?.last ?? null,
      range_units: (rr?.units ?? ZERO).toString(), range_items: rr?.items ?? 0,
    };
  });

  // Warnings: a bill two products both report (counted twice), failing and stale feeds.
  const warnings: Warning[] = [];
  const inv = new Map<string, { pids: Set<string>; vendor: string; id: string }>();
  for (const r of rows) {
    if (!r.invoice_id) continue;
    const k = `${r.vendor}\u0000${r.invoice_id}`;
    const x = inv.get(k) ?? { pids: new Set<string>(), vendor: r.vendor, id: r.invoice_id };
    x.pids.add(r.pid); inv.set(k, x);
  }
  for (const x of inv.values()) if (x.pids.size > 1) {
    const who = [...x.pids].map((p) => names.get(p) ?? p);
    warnings.push({ kind: "duplicate-invoice", title: `${x.vendor} invoice ${x.id} is reported by ${who.length} products`, detail: `${who.join(" and ")} both list it, so it's counted ${who.length} times. Each bill should come from one product (spec §3.8).`, pids: [...x.pids] });
  }
  const now = Date.now();
  for (const c of cards) {
    if (c.health === "error") warnings.push({ kind: "feed-error", title: `${c.name}: the last pull failed`, detail: `${c.last_error ?? "Unknown error"} — showing the last good figures${c.last_ok_at ? ` (from ${c.last_ok_at.slice(0, 16).replace("T", " ")} UTC)` : ""}.`, pids: [c.pid] });
    else if (c.health === "ok" && c.last_ok_at && now - Date.parse(c.last_ok_at) > 2 * 86_400_000) warnings.push({ kind: "stale", title: `${c.name} hasn't been updated in ${Math.floor((now - Date.parse(c.last_ok_at)) / 86_400_000)} days`, detail: "The daily pull hasn't succeeded since then. Press Refresh to try now.", pids: [c.pid] });
  }

  const lastOk = products.map((p) => p.last_ok_at).filter((x): x is string => !!x).sort().pop() ?? null;
  return {
    filters: {
      from: f.from, to: f.to, group: f.group, status: f.status ?? "all",
      product: f.product ?? null, category: f.category ?? null, vendor: f.vendor ?? null, model: f.model ?? null,
      client: f.client ?? null, feature: f.feature ?? null, currency,
    },
    currency, currencies, totals, previous, periods,
    series: { byProduct: ser(byProduct), byCategory: ser(byCategory) },
    seriesKeys: {
      products: rank(byProduct).map((k) => ({ key: k, label: names.get(k) ?? k })),
      categories: rank(byCategory).map((k) => ({ key: k, label: k })),
    },
    breakdowns, items, itemsTruncated: sorted.length > MAX_ITEMS, options, products: cards, warnings,
    lastRefreshedAt: lastOk, generatedAt: new Date().toISOString(),
  };
}

export { NOT_ALLOCATED };
