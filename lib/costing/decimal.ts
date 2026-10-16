/**
 * Exact money for the Costing section (docs/costing-feed-spec.md §3, §8).
 *
 * Every amount arrives as a decimal string with up to 12 decimal places and is
 * kept as an integer count of 1e-12 currency units (a bigint, stored as text),
 * so every sum is exact. Nothing here ever goes through a floating-point number.
 */

export const SCALE_DIGITS = 12;
const SCALE = BigInt(10) ** BigInt(SCALE_DIGITS);

/** "3.36750000" → 3367500000000n (units of 1e-12). Null when it isn't an exact decimal string. */
export function parseUnits(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const m = /^(-)?(0|[1-9]\d*)(?:\.(\d{1,12}))?$/.exec(value);
  if (!m) return null;
  const units = BigInt(m[2]) * SCALE + BigInt((m[3] ?? "").padEnd(SCALE_DIGITS, "0") || "0");
  return m[1] ? -units : units;
}

/** Why a value isn't an exact decimal string (for feed errors). */
export function decimalProblem(value: unknown): string {
  if (typeof value === "number") return "is a JSON number — it must be a decimal string (e.g. \"3.36750000\")";
  if (typeof value !== "string") return "is missing or not a string";
  if (/^-?\d+\.\d{13,}$/.test(value)) return `has more than ${SCALE_DIGITS} decimal places`;
  return `isn't a plain decimal ("${value.slice(0, 40)}")`;
}

/** Units → canonical decimal string with all 12 places ("3.367500000000"). */
export function unitsToFull(units: bigint): string {
  const neg = units < BigInt(0);
  const abs = neg ? -units : units;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(SCALE_DIGITS, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

/** Units → display string: exact, trailing zeros trimmed, at least 2 decimals (spec §8). "40.0595", "20.00". */
export function formatUnits(units: bigint, opts: { grouping?: boolean } = {}): string {
  const full = unitsToFull(units);
  const neg = full.startsWith("-");
  const [whole, frac] = (neg ? full.slice(1) : full).split(".");
  let f = frac.replace(/0+$/, "");
  if (f.length < 2) f = f.padEnd(2, "0");
  const w = opts.grouping ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
  return `${neg ? "-" : ""}${w}.${f}`;
}

/** An exact decimal string → its display form (null when it isn't one). */
export function formatDecimal(value: string, opts: { grouping?: boolean } = {}): string | null {
  const u = parseUnits(value);
  return u === null ? null : formatUnits(u, opts);
}

const SYMBOL: Record<string, string> = { USD: "$", INR: "₹", EUR: "€", GBP: "£", CAD: "CA$", AUD: "A$" };
/** "$3.3675", "-$10.00", "₹52.20", or "12.50 SEK" for currencies without a symbol here. Exact — never rounded. */
export function formatMoney(units: bigint, currency: string): string {
  const s = formatUnits(units, { grouping: true });
  const sym = SYMBOL[currency.toUpperCase()];
  if (!sym) return `${s} ${currency.toUpperCase()}`;
  return s.startsWith("-") ? `-${sym}${s.slice(1)}` : `${sym}${s}`;
}

/**
 * A metered item's amount must equal Σ(quantity × unit_price ÷ price_per) exactly (spec §6).
 * Compared as fractions in integers, so nothing is rounded on the way.
 */
export function meteredMatches(amount: bigint, priced: Array<{ quantity: bigint; unitPrice: bigint; pricePer: bigint }>): boolean {
  if (!priced.length || priced.some((p) => p.pricePer === BigInt(0))) return false;
  // Each term is (q/S)·(p/S)/(r/S) = q·p/(r·S). Sum them over a common denominator Π(r)·S.
  const den = priced.reduce((d, p) => d * p.pricePer, BigInt(1));
  const num = priced.reduce((n, p) => n + p.quantity * p.unitPrice * (den / p.pricePer), BigInt(0));
  // amount/S == num/(den·S)  ⇔  amount·den == num
  return amount * den === num;
}
