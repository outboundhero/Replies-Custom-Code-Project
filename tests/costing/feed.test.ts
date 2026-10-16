/**
 * Costing feed checks (docs/costing-feed-spec.md). Run: npx tsx tests/costing/feed.test.ts
 * The spec's own example must pass; each way of breaking it must be rejected for the right reason.
 */
import { checkFeed } from "../../lib/costing/validate";
import { parseUnits, formatUnits, formatMoney, unitsToFull, meteredMatches } from "../../lib/costing/decimal";
import { periodsFor } from "../../lib/costing/query";
import { windows } from "../../lib/costing/pull";

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, x: unknown = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗ FAIL:", n, typeof x === "string" ? x : JSON.stringify(x)); } };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// The example document from the spec, §2.
export const SPEC_EXAMPLE = {
  schema_version: "1.0",
  product: { id: "lead-database", name: "Lead Database", environment: "production" },
  period: { from: "2026-10-01", to: "2026-10-09" },
  generated_at: "2026-10-09T20:15:00Z",
  totals: [{ currency: "USD", amount: "40.0595" }, { currency: "INR", amount: "52.20" }],
  line_items: [
    {
      id: "2026-10-08:openai:gpt-4o-mini:enrichment", date: "2026-10-08", category: "ai", vendor: "openai", service: "chat.completions",
      model: "gpt-4o-mini", description: "Company enrichment summaries", billing_type: "usage", amount: "3.36750000", currency: "USD",
      source: "provider_api", status: "final",
      usage: [
        { metric: "requests", quantity: "5210" },
        { metric: "input_tokens", quantity: "9450000", unit_price: "0.15", price_per: "1000000" },
        { metric: "cached_input_tokens", quantity: "1200000", unit_price: "0.075", price_per: "1000000" },
        { metric: "output_tokens", quantity: "3100000", unit_price: "0.60", price_per: "1000000" },
      ],
      allocations: [
        { dimension: "client", key: "DBSM", amount: "1.20412500" },
        { dimension: "client", key: "CCGEN", amount: "0.84937500" },
        { dimension: "client", key: "unattributed", amount: "1.31400000" },
      ],
    },
    {
      id: "vercel:inv_8F2KQ1:pro-plan", date: "2026-10-01", category: "hosting", vendor: "vercel", description: "Vercel Pro plan — October",
      billing_type: "subscription", amount: "20.00", currency: "USD", source: "invoice", status: "final",
      invoice: { id: "inv_8F2KQ1", url: "https://vercel.com/…/invoices/inv_8F2KQ1" },
      subscription: { plan: "Pro", interval: "month", seats: "1", service_from: "2026-10-01", service_to: "2026-10-31" },
    },
    {
      id: "2026-10-08:vercel:function-duration", date: "2026-10-08", category: "hosting", vendor: "vercel", service: "functions",
      billing_type: "usage", amount: "1.6920", currency: "USD", source: "provider_api", status: "pending",
      usage: [{ metric: "compute_gb_hours", quantity: "9.4", unit_price: "0.18", price_per: "1" }], attributes: { region: "sin1" },
    },
    {
      id: "supabase:inv_00231:pro-plan", date: "2026-10-03", category: "database", vendor: "supabase", billing_type: "subscription",
      amount: "25.00", currency: "USD", source: "invoice", status: "final", invoice: { id: "inv_00231" },
      subscription: { plan: "Pro", interval: "month", service_from: "2026-10-03", service_to: "2026-11-02" },
    },
    {
      id: "supabase:inv_00231:credit", date: "2026-10-03", category: "database", vendor: "supabase", billing_type: "credit",
      amount: "-10.00", currency: "USD", source: "invoice", status: "final", invoice: { id: "inv_00231" }, description: "Compute credit",
    },
    {
      id: "google-workspace:inv_7781:tax", date: "2026-10-01", category: "email_infrastructure", vendor: "google-workspace",
      billing_type: "tax", amount: "52.20", currency: "INR", source: "invoice", status: "final", invoice: { id: "inv_7781" }, description: "GST 18%",
    },
  ],
};
const R = { from: "2026-10-01", to: "2026-10-09", slug: null as string | null };
const reject = (doc: unknown, why: RegExp, name: string, expect = R) => {
  const c = checkFeed(doc, expect);
  ok(!c.ok && c.errors.some((e) => why.test(e)), name, c.ok ? "accepted" : c.errors);
};

console.log("Exact decimals");
ok(parseUnits("3.36750000") === BigInt("3367500000000"), "parse 3.36750000");
ok(parseUnits("-10.00") === BigInt("-10000000000000"), "parse a credit");
ok(parseUnits("0.000000000001") === BigInt(1), "12 decimal places");
ok(parseUnits("0.0000000000001") === null && parseUnits(3.5) === null && parseUnits("1e3") === null && parseUnits("01.5") === null && parseUnits("1.") === null && parseUnits("") === null, "rejects 13 places, numbers, exponents, odd forms");
ok(formatUnits(parseUnits("40.05950000")!) === "40.0595" && formatUnits(parseUnits("20")!) === "20.00" && formatUnits(parseUnits("1.5")!) === "1.50", "display: trailing zeros trimmed, at least 2 decimals");
ok(formatMoney(parseUnits("1234567.891")!, "USD") === "$1,234,567.891" && formatMoney(parseUnits("-10")!, "USD") === "-$10.00" && formatMoney(parseUnits("52.2")!, "INR") === "₹52.20" && formatMoney(parseUnits("5")!, "SEK") === "5.00 SEK", "money formatting, exact");
ok(unitsToFull(BigInt("99999999999999999999")) === "99999999.999999999999", "large amounts stay exact (no float)");
const big = parseUnits("0.1")! + parseUnits("0.2")!;
ok(formatUnits(big) === "0.30", "0.1 + 0.2 = 0.30 exactly");
ok(meteredMatches(parseUnits("3.3675")!, [
  { quantity: parseUnits("9450000")!, unitPrice: parseUnits("0.15")!, pricePer: parseUnits("1000000")! },
  { quantity: parseUnits("1200000")!, unitPrice: parseUnits("0.075")!, pricePer: parseUnits("1000000")! },
  { quantity: parseUnits("3100000")!, unitPrice: parseUnits("0.60")!, pricePer: parseUnits("1000000")! },
]), "metered check: the spec's AI item is exactly Σ(q × price ÷ per)");
ok(!meteredMatches(parseUnits("3.3676")!, [{ quantity: parseUnits("9450000")!, unitPrice: parseUnits("0.15")!, pricePer: parseUnits("1000000")! }]), "metered check catches a mismatch");

console.log("\nThe spec's example");
const good = checkFeed(SPEC_EXAMPLE, R);
ok(good.ok, "is accepted", good.ok ? "" : good.errors);
if (good.ok) {
  ok(good.feed.items.length === 6 && good.feed.productSlug === "lead-database", "6 items, product lead-database");
  ok(good.feed.items.find((i) => i.id === "supabase:inv_00231:credit")!.units === parseUnits("-10.00"), "credit kept negative");
}
ok(checkFeed({ ...clone(SPEC_EXAMPLE), line_items: [], totals: [] }, R).ok, "an empty range ([] / []) is accepted");
const metered = clone(SPEC_EXAMPLE); metered.line_items[0].source = "metered";
ok(checkFeed(metered, R).ok, "a metered AI item whose amount is exactly Σ(q × price ÷ per) is accepted");

console.log("\nRejected for the right reason");
let d = clone(SPEC_EXAMPLE); d.totals[0].amount = "40.0596"; reject(d, /totals for USD is 40.0596, but the line items add up to 40.0595/, "totals off by 0.0001");
d = clone(SPEC_EXAMPLE); (d.line_items[1] as Record<string, unknown>).amount = 20; reject(d, /amount is a JSON number/, "a JSON number amount");
d = clone(SPEC_EXAMPLE); d.line_items[0].allocations![2].amount = "1.31300000"; reject(d, /allocations for "client" add up to/, "allocations that don't add up");
d = clone(SPEC_EXAMPLE); d.line_items[2].id = d.line_items[0].id; reject(d, /same id appears twice/, "a duplicate id");
d = clone(SPEC_EXAMPLE); d.line_items[2].date = "2026-10-10"; reject(d, /outside the requested range/, "a date outside the range");
d = clone(SPEC_EXAMPLE); d.line_items[2].date = "2026-02-30"; reject(d, /real YYYY-MM-DD/, "an impossible date");
d = clone(SPEC_EXAMPLE); delete (d.line_items[0] as Record<string, unknown>).model; reject(d, /model is required/, "an AI item without a model");
d = clone(SPEC_EXAMPLE); d.line_items[4].amount = "10.00"; d.totals[0].amount = "60.0595"; reject(d, /credit must have a negative amount/, "a positive credit");
d = clone(SPEC_EXAMPLE); d.line_items[1].amount = "-20.00"; reject(d, /only credits, discounts and refunds/, "a negative subscription");
d = clone(SPEC_EXAMPLE); delete (d.line_items[3] as Record<string, unknown>).invoice; reject(d, /invoice \{ id \} is required/, "source invoice without invoice");
d = clone(SPEC_EXAMPLE); delete (d.line_items[3] as Record<string, unknown>).subscription; reject(d, /subscription \{ plan/, "a subscription without its period");
d = clone(SPEC_EXAMPLE); d.line_items[5].currency = "inr"; reject(d, /ISO 4217/, "a lowercase currency");
d = clone(SPEC_EXAMPLE); d.totals = d.totals.slice(0, 1); reject(d, /totals is missing INR/, "a currency missing from totals");
d = clone(SPEC_EXAMPLE); d.period.to = "2026-10-08"; reject(d, /period must echo the request/, "a period that doesn't echo the request");
d = clone(SPEC_EXAMPLE); d.schema_version = "2.0"; reject(d, /schema_version/, "an unknown schema version");
reject(SPEC_EXAMPLE, /product\.id changed/, "a product whose id changed", { ...R, slug: "database" });
d = clone(SPEC_EXAMPLE); d.line_items[0].usage![1].quantity = 9450000 as unknown as string; reject(d, /quantity is a JSON number/, "a JSON-number quantity");
d = clone(SPEC_EXAMPLE); d.line_items[0].amount = "3.3675000000001"; reject(d, /more than 12 decimal places/, "13 decimal places");
reject(metered.line_items ? (() => { const m = clone(metered); m.line_items[0].amount = "3.37"; m.line_items[0].allocations = undefined as never; m.totals[0].amount = "40.0620"; return m; })() : null, /metered AI amount must equal/, "a metered AI amount that isn't Σ(q × price ÷ per)");
d = clone(SPEC_EXAMPLE); d.line_items[2].attributes = { region: { nested: true } } as never; reject(d, /flat object/, "nested attributes");
reject([], /isn't a JSON object/, "an array instead of a document");

console.log("\nPeriods and windows (UTC)");
const w = periodsFor("2026-10-01", "2026-10-31", "week");
ok(w[0].key === "2026-09-28" && w[0].from === "2026-10-01" && w[0].label === "Oct 1 – 4" && w[w.length - 1].to === "2026-10-31", "weeks run Monday–Sunday, clipped to the range", w.slice(0, 2));
ok(periodsFor("2026-09-15", "2026-11-03", "month").map((p) => p.key).join() === "2026-09,2026-10,2026-11", "calendar months");
ok(periodsFor("2026-10-01", "2026-10-03", "day").length === 3, "days inclusive");
ok(periodsFor("2026-12-28", "2027-01-05", "week").map((p) => p.label).join(" | ") === "Dec 28 – Jan 3 | Jan 4 – 5", "a week across the year end", periodsFor("2026-12-28", "2027-01-05", "week").map((p) => p.label));
const ws = windows("2026-01-01", "2026-12-31");
ok(ws.length === 4 && ws.every((x) => (Date.parse(x.to) - Date.parse(x.from)) / 864e5 + 1 <= 92) && ws[0].from === "2026-01-01" && ws[3].to === "2026-12-31" && ws.every((x, i) => i === 0 || x.from === new Date(Date.parse(ws[i - 1].to) + 864e5).toISOString().slice(0, 10)), "a year splits into ≤92-day windows with no gaps", ws);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
