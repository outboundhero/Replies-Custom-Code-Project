import { formatMoney, formatUnits, parseUnits, unitsToFull } from "@/lib/costing/decimal";

/** Exact money from a units string ("3367500000000" → "$3.3675"). Never rounded. */
export const money = (units: string | bigint, currency: string) => formatMoney(typeof units === "bigint" ? units : BigInt(units), currency);
export const plain = (units: string | bigint) => formatUnits(typeof units === "bigint" ? units : BigInt(units), { grouping: true });
/** For bar heights and percentages only — display amounts always come from `money`. */
export const toNumber = (units: string | bigint) => Number(typeof units === "bigint" ? units : BigInt(units)) / 1e12;
export const isZero = (units: string) => BigInt(units) === BigInt(0);

export function pct(part: string, whole: string): string {
  const w = toNumber(whole);
  if (!w) return "—";
  const p = (toNumber(part) / w) * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
}

const CATEGORY: Record<string, string> = {
  ai: "AI", hosting: "Hosting", database: "Database", storage: "Storage", email_infrastructure: "Email infrastructure",
  data: "Data", api: "APIs", saas: "SaaS", monitoring: "Monitoring", other: "Other",
};
export const categoryLabel = (c: string) => CATEGORY[c] ?? c.replace(/[_-]+/g, " ").replace(/^\w/, (x) => x.toUpperCase());

const VENDOR: Record<string, string> = {
  openai: "OpenAI", anthropic: "Anthropic", google: "Google", "google-cloud": "Google Cloud", "google-workspace": "Google Workspace",
  vercel: "Vercel", supabase: "Supabase", turso: "Turso", aws: "AWS", "aws-s3": "AWS S3", cloudflare: "Cloudflare", "cloudflare-r2": "Cloudflare R2",
  apollo: "Apollo", zoominfo: "ZoomInfo", clay: "Clay", "google-maps": "Google Maps", bison: "Email Bison", emailbison: "Email Bison",
  "microsoft-365": "Microsoft 365", emailguard: "EmailGuard", twilio: "Twilio", zerobounce: "ZeroBounce", slack: "Slack", airtable: "Airtable",
  close: "Close", notion: "Notion", sentry: "Sentry", betterstack: "Better Stack", railway: "Railway", render: "Render", neon: "Neon",
  mongodb: "MongoDB", mistral: "Mistral", porkbun: "Porkbun", n8n: "n8n", upstash: "Upstash", github: "GitHub",
};
export const vendorLabel = (v: string) => VENDOR[v] ?? v.split(/[-_]+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

const BILLING: Record<string, string> = {
  usage: "Usage", subscription: "Subscription", one_time: "One-time", tax: "Tax", fee: "Fee", credit: "Credit", discount: "Discount", refund: "Refund",
};
export const billingLabel = (b: string) => BILLING[b] ?? b;
export const sourceLabel = (s: string) => (s === "provider_api" ? "Provider billing API" : s === "invoice" ? "Invoice" : s === "metered" ? "Metered" : s);
const ACRONYM: Record<string, string> = { gb: "GB", tb: "TB", mb: "MB", ai: "AI", api: "API", sms: "SMS", mx: "MX", url: "URL", id: "ID" };
export const metricLabel = (m: string) =>
  m.split(/[_\s]+/).map((w, i) => ACRONYM[w.toLowerCase()] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");

/** An exact quantity: thousands grouped, trailing zeros trimmed, no forced decimals ("9,450,000", "104.4"). */
export function qty(value: string | undefined): string {
  if (!value) return "";
  const u = parseUnits(value);
  if (u === null) return value;
  const full = unitsToFull(u);
  const [w, f] = full.replace(/^-/, "").split(".");
  const frac = f.replace(/0+$/, "");
  return `${full.startsWith("-") ? "-" : ""}${w.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
}

/** quantity × unit_price ÷ price_per, in units — only when it divides exactly (else null: never rounded). */
export function lineUnits(q?: string, price?: string, per?: string): bigint | null {
  const qu = q ? parseUnits(q) : null, pu = price ? parseUnits(price) : null, ru = per ? parseUnits(per) : BigInt(10) ** BigInt(12);
  if (qu === null || pu === null || ru === null || ru === BigInt(0)) return null;
  const num = qu * pu;
  return num % ru === BigInt(0) ? num / ru : null;
}

// A calm, distinct palette — the same key always gets the same colour.
const PALETTE = ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6", "#f97316", "#64748b", "#84cc16", "#e11d48", "#06b6d4"];
export function colorFor(key: string, order?: string[]): string {
  const i = order ? order.indexOf(key) : -1;
  if (i >= 0) return PALETTE[i % PALETTE.length];
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dateLabel = (d: string, withYear = false) =>
  `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}${withYear ? `, ${d.slice(0, 4)}` : ""}`;
export const rangeLabel = (from: string, to: string) => {
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return from === to ? dateLabel(from, true) : `${dateLabel(from, !sameYear)} – ${dateLabel(to, true)}`;
};

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export const CATEGORY_OPTIONS = ["ai", "hosting", "database", "storage", "email_infrastructure", "data", "api", "saas", "monitoring", "other"];
export const BILLING_OPTIONS = ["subscription", "one_time", "usage", "tax", "fee", "credit", "discount", "refund"];
export const CURRENCY_OPTIONS = ["USD", "INR", "EUR", "GBP", "CAD", "AUD"];
