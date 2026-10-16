/**
 * Checks a product's costing feed against docs/costing-feed-spec.md before anything is stored:
 * schema, required fields, exact decimal strings (never JSON numbers), totals per currency,
 * allocation sums, unique ids, dates inside the requested range, and metered AI amounts.
 * A feed with any problem is rejected whole (spec §8) — the last good data stays.
 */
import { parseUnits, decimalProblem, meteredMatches, unitsToFull } from "./decimal";

export const BILLING_TYPES = ["usage", "subscription", "one_time", "tax", "fee", "credit", "discount", "refund"] as const;
const NEGATIVE_OK = new Set(["credit", "discount", "refund"]);
const SOURCES = new Set(["invoice", "provider_api", "metered"]);
const STATUSES = new Set(["final", "pending"]);

export interface CleanItem {
  id: string;
  date: string;
  category: string;
  vendor: string;
  service: string | null;
  model: string | null;
  description: string | null;
  billing_type: string;
  amount: string;          // the feed's exact string
  units: bigint;           // the same amount in 1e-12 units
  currency: string;
  source: string;
  status: "final" | "pending";
  invoice_id: string | null;
  invoice_url: string | null;
  /** usage / subscription / allocations / attributes, as sent. */
  extra: { usage?: unknown[]; subscription?: unknown; allocations?: Array<{ dimension: string; key: string; amount: string }>; attributes?: Record<string, unknown> };
}

export interface CleanFeed {
  productSlug: string;
  productName: string;
  environment: string;
  notes: string | null;
  generatedAt: string;
  items: CleanItem[];
}

export type FeedCheck = { ok: true; feed: CleanFeed } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isUtcDate(s: unknown): s is string {
  if (typeof s !== "string" || !DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * @param expect.slug  the product id this feed must carry (null on a product's first pull)
 */
export function checkFeed(body: unknown, expect: { from: string; to: string; slug: string | null }): FeedCheck {
  const errors: string[] = [];
  const err = (m: string) => { if (errors.length < 50) errors.push(m); };
  if (!isObj(body)) return { ok: false, errors: ["The answer isn't a JSON object."] };

  // Envelope (spec §4).
  if (typeof body.schema_version !== "string" || !/^1\.\d+$/.test(body.schema_version)) err(`schema_version must be "1.0" (got ${JSON.stringify(body.schema_version)}).`);
  const product = isObj(body.product) ? body.product : null;
  const slug = str(product?.id);
  const name = str(product?.name);
  if (!slug) err("product.id is missing.");
  else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) err(`product.id "${slug}" must be a lowercase slug (letters, digits, "-").`);
  else if (expect.slug && slug !== expect.slug) err(`product.id changed: this product is "${expect.slug}", the feed says "${slug}". A product's id must never change.`);
  if (!name) err("product.name is missing.");
  const period = isObj(body.period) ? body.period : null;
  if (!period || period.from !== expect.from || period.to !== expect.to) err(`period must echo the request (${expect.from} → ${expect.to}); got ${JSON.stringify(body.period ?? null)}.`);
  if (typeof body.generated_at !== "string" || Number.isNaN(Date.parse(body.generated_at))) err("generated_at must be an ISO timestamp.");
  if (!Array.isArray(body.line_items)) err("line_items must be an array.");
  if (!Array.isArray(body.totals)) err("totals must be an array.");
  if (errors.length) return { ok: false, errors };

  // Line items (spec §3, §4, §6, §7).
  const items: CleanItem[] = [];
  const seen = new Set<string>();
  const sums = new Map<string, bigint>();
  (body.line_items as unknown[]).forEach((raw, i) => {
    const at = (m: string) => err(`line_items[${i}]${isObj(raw) && typeof raw.id === "string" ? ` (${raw.id})` : ""}: ${m}`);
    if (!isObj(raw)) { at("isn't an object."); return; }
    const id = str(raw.id);
    if (!id) at("id is missing.");
    else if (seen.has(id)) at("the same id appears twice — ids must be unique.");
    else seen.add(id);
    if (!isUtcDate(raw.date)) at(`date must be a real YYYY-MM-DD date (got ${JSON.stringify(raw.date)}).`);
    else if (raw.date < expect.from || raw.date > expect.to) at(`date ${raw.date} is outside the requested range ${expect.from} → ${expect.to}.`);
    const category = str(raw.category); if (!category) at("category is missing.");
    const vendor = str(raw.vendor); if (!vendor) at("vendor is missing.");
    const model = str(raw.model);
    if (category === "ai" && !model) at("model is required when category is \"ai\".");
    const bt = str(raw.billing_type);
    if (!bt || !(BILLING_TYPES as readonly string[]).includes(bt)) at(`billing_type must be one of ${BILLING_TYPES.join(", ")} (got ${JSON.stringify(raw.billing_type)}).`);
    const units = parseUnits(raw.amount);
    if (units === null) at(`amount ${decimalProblem(raw.amount)}.`);
    else if (bt && NEGATIVE_OK.has(bt) && units > BigInt(0)) at(`a ${bt} must have a negative amount (got ${raw.amount}).`);
    else if (bt && !NEGATIVE_OK.has(bt) && units < BigInt(0)) at(`amount is negative, which only credits, discounts and refunds may be.`);
    const currency = typeof raw.currency === "string" && /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : null;
    if (!currency) at(`currency must be an ISO 4217 code like "USD" (got ${JSON.stringify(raw.currency)}).`);
    const source = str(raw.source); if (!source || !SOURCES.has(source)) at(`source must be invoice, provider_api or metered (got ${JSON.stringify(raw.source)}).`);
    const status = str(raw.status); if (!status || !STATUSES.has(status)) at(`status must be final or pending (got ${JSON.stringify(raw.status)}).`);
    for (const k of ["service", "description"] as const) if (raw[k] != null && typeof raw[k] !== "string") at(`${k} must be a string.`);

    let invoiceId: string | null = null, invoiceUrl: string | null = null;
    if (raw.invoice != null) {
      if (!isObj(raw.invoice) || !str(raw.invoice.id)) at("invoice must be { id, url? }.");
      else { invoiceId = String(raw.invoice.id); invoiceUrl = typeof raw.invoice.url === "string" ? raw.invoice.url : null; }
    }
    if (source === "invoice" && !invoiceId) at("invoice { id } is required when source is \"invoice\".");

    if (bt === "subscription") {
      const s = isObj(raw.subscription) ? raw.subscription : null;
      if (!s) at("subscription { plan, interval, service_from, service_to } is required for subscription items.");
      else {
        if (!str(s.plan)) at("subscription.plan is missing.");
        if (s.interval !== "month" && s.interval !== "year") at("subscription.interval must be \"month\" or \"year\".");
        if (!isUtcDate(s.service_from) || !isUtcDate(s.service_to)) at("subscription.service_from / service_to must be YYYY-MM-DD dates.");
        if (s.seats != null && parseUnits(s.seats) === null) at(`subscription.seats ${decimalProblem(s.seats)}.`);
      }
    }

    // usage[]: strings throughout; a metered AI item must equal Σ(quantity × unit_price ÷ price_per).
    const priced: Array<{ quantity: bigint; unitPrice: bigint; pricePer: bigint }> = [];
    if (raw.usage != null) {
      if (!Array.isArray(raw.usage)) at("usage must be an array.");
      else raw.usage.forEach((u, j) => {
        if (!isObj(u) || !str(u.metric)) { at(`usage[${j}].metric is missing.`); return; }
        const q = parseUnits(u.quantity);
        if (q === null) at(`usage[${j}] (${u.metric}) quantity ${decimalProblem(u.quantity)}.`);
        const hasPrice = u.unit_price != null || u.price_per != null;
        const p = u.unit_price != null ? parseUnits(u.unit_price) : null;
        const r = u.price_per != null ? parseUnits(u.price_per) : null;
        if (u.unit_price != null && p === null) at(`usage[${j}] (${u.metric}) unit_price ${decimalProblem(u.unit_price)}.`);
        if (u.price_per != null && r === null) at(`usage[${j}] (${u.metric}) price_per ${decimalProblem(u.price_per)}.`);
        if (hasPrice && q !== null && p !== null) priced.push({ quantity: q, unitPrice: p, pricePer: r ?? BigInt(10) ** BigInt(12) });
      });
    }
    if (source === "metered" && category === "ai" && units !== null && priced.length && !meteredMatches(units, priced)) {
      at(`a metered AI amount must equal Σ(quantity × unit_price ÷ price_per) exactly; ${raw.amount} doesn't.`);
    }

    // allocations[]: per dimension, the amounts sum exactly to the item amount.
    let allocations: CleanItem["extra"]["allocations"];
    if (raw.allocations != null) {
      if (!Array.isArray(raw.allocations)) at("allocations must be an array.");
      else {
        const byDim = new Map<string, bigint>();
        const keys = new Set<string>();
        allocations = [];
        raw.allocations.forEach((a, j) => {
          if (!isObj(a) || !str(a.dimension) || !str(a.key)) { at(`allocations[${j}] needs dimension, key and amount.`); return; }
          const au = parseUnits(a.amount);
          if (au === null) { at(`allocations[${j}] (${a.dimension}=${a.key}) amount ${decimalProblem(a.amount)}.`); return; }
          const k = `${a.dimension}\u0000${a.key}`;
          if (keys.has(k)) at(`allocations[${j}]: ${a.dimension}=${a.key} appears twice.`);
          keys.add(k);
          byDim.set(String(a.dimension), (byDim.get(String(a.dimension)) ?? BigInt(0)) + au);
          allocations!.push({ dimension: String(a.dimension), key: String(a.key), amount: String(a.amount) });
        });
        if (units !== null) for (const [dim, total] of byDim) {
          if (total !== units) at(`allocations for "${dim}" add up to ${unitsToFull(total)}, not the item amount ${raw.amount} (put any remainder on key "unattributed").`);
        }
      }
    }

    if (raw.attributes != null) {
      if (!isObj(raw.attributes) || Object.values(raw.attributes).some((v) => !["string", "number", "boolean"].includes(typeof v))) at("attributes must be a flat object of strings, numbers or booleans.");
    }

    if (id && category && vendor && bt && units !== null && currency && source && status && isUtcDate(raw.date)) {
      if (currency) sums.set(currency, (sums.get(currency) ?? BigInt(0)) + units);
      items.push({
        id, date: raw.date, category, vendor,
        service: typeof raw.service === "string" ? raw.service : null,
        model, description: typeof raw.description === "string" ? raw.description : null,
        billing_type: bt, amount: raw.amount as string, units, currency, source,
        status: status as "final" | "pending", invoice_id: invoiceId, invoice_url: invoiceUrl,
        extra: {
          ...(Array.isArray(raw.usage) ? { usage: raw.usage } : {}),
          ...(isObj(raw.subscription) ? { subscription: raw.subscription } : {}),
          ...(allocations ? { allocations } : {}),
          ...(isObj(raw.attributes) ? { attributes: raw.attributes } : {}),
        },
      });
    }
  });

  // totals[] must be exactly the per-currency sums (spec §3.9).
  const seenCur = new Set<string>();
  (body.totals as unknown[]).forEach((t, i) => {
    if (!isObj(t) || typeof t.currency !== "string") { err(`totals[${i}] needs currency and amount.`); return; }
    if (seenCur.has(t.currency)) err(`totals lists ${t.currency} twice.`);
    seenCur.add(t.currency);
    const u = parseUnits(t.amount);
    if (u === null) { err(`totals[${i}] (${t.currency}) amount ${decimalProblem(t.amount)}.`); return; }
    const want = sums.get(t.currency) ?? BigInt(0);
    if (!sums.has(t.currency)) err(`totals lists ${t.currency}, but no line item is in ${t.currency}.`);
    else if (u !== want) err(`totals for ${t.currency} is ${t.amount}, but the line items add up to ${unitsToFull(want)}.`);
  });
  for (const cur of sums.keys()) if (!seenCur.has(cur)) err(`totals is missing ${cur} (the line items have ${cur} amounts).`);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    feed: {
      productSlug: slug!, productName: name!,
      environment: str(product?.environment) ?? "production",
      notes: typeof body.notes === "string" ? body.notes : null,
      generatedAt: body.generated_at as string,
      items,
    },
  };
}
