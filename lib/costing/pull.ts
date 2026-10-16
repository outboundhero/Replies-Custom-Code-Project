/**
 * Pulls each product's costing feed (docs/costing-feed-spec.md §1): GET {base}/api/costing?from&to
 * with the product's Bearer key. Daily by cron and on Refresh, re-pulling the last 35 days — plus,
 * on our side, any older day still marked pending, so a late-finalised figure is never left pending.
 * A product's first pull brings in the last 12 months, so its history is there from day one.
 * Ranges over 92 days are split. Every window is checked before anything is written; a failing
 * product keeps its last good data and shows the error.
 */
import { checkFeed, type CleanFeed } from "./validate";
import { openKey } from "./secret";
import {
  ensureCostingTables, getProductWithKey, listProducts, markPullResult, recordPull, applyRange,
  oldestPendingDate, slugTakenBy, type ApplyResult,
} from "./store";

export const REPULL_DAYS = 35;
export const BACKFILL_DAYS = 365;
export const MAX_RANGE_DAYS = 92;
const MAX_LOOKBACK_DAYS = 400;
const TIMEOUT_MS = 30_000;

const DAY = 86_400_000;
export const utcToday = () => new Date().toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

/** [from, to] split into windows of at most 92 days (both ends inclusive). */
export function windows(from: string, to: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (let s = from; s <= to; s = addDays(s, MAX_RANGE_DAYS)) {
    const e = addDays(s, MAX_RANGE_DAYS - 1);
    out.push({ from: s, to: e < to ? e : to });
  }
  return out;
}

/** A product base URL we're willing to call: https (http only off production), no private network hosts. */
export function cleanBaseUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, error: "That isn't a valid URL." }; }
  const prod = process.env.NODE_ENV === "production" && process.env.COSTING_ALLOW_HTTP !== "1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && !prod)) return { ok: false, error: "The URL must start with https://" };
  if (u.username || u.password) return { ok: false, error: "Don't put a login in the URL — the key goes in its own field." };
  if (u.search || u.hash) return { ok: false, error: "Use just the product's base URL (no ?query or #)." };
  const h = u.hostname.toLowerCase();
  const privateHost = h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "0.0.0.0" || h === "::1" || h === "[::1]" ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (privateHost && prod) return { ok: false, error: "That address is on a private network." };
  const path = u.pathname.replace(/\/+$/, "").replace(/\/api\/costing$/, "");
  return { ok: true, url: `${u.origin}${path}` };
}

async function fetchFeed(baseUrl: string, apiKey: string, from: string, to: string): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  const url = `${baseUrl}/api/costing?from=${from}&to=${to}`;
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, cache: "no-store", signal: ctrl.signal });
      const text = await res.text();
      clearTimeout(t);
      if (res.status === 401) return { ok: false, error: "The product refused the key (401) — check the key." };
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { body = null; }
      const said = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : text.slice(0, 200);
      if (res.status >= 500 && attempt === 0) { last = `${res.status}: ${said}`; await new Promise((r) => setTimeout(r, 1500)); continue; }
      if (!res.ok) return { ok: false, error: `The product answered ${res.status} for ${from} → ${to}: ${said}` };
      if (body === null) return { ok: false, error: `The product's answer for ${from} → ${to} isn't JSON.` };
      return { ok: true, body };
    } catch (e) {
      clearTimeout(t);
      last = (e as Error).name === "AbortError" ? `no answer within ${TIMEOUT_MS / 1000}s` : (e as Error).message;
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
    }
  }
  return { ok: false, error: `Couldn't reach the product (${url.split("?")[0]}): ${last}` };
}

export interface PullOutcome extends Partial<ApplyResult> {
  pid: string;
  name: string;
  ok: boolean;
  skipped?: string;
  error?: string;
  from?: string;
  to?: string;
}

/** Pull one product. `range` overrides the default (last 35 days + any older pending day). */
export async function pullProduct(pid: string, opts: { trigger: string; range?: { from: string; to: string } }): Promise<PullOutcome> {
  await ensureCostingTables();
  const p = await getProductWithKey(pid);
  if (!p) return { pid, name: "?", ok: false, error: "No such product." };
  if (p.kind !== "feed") return { pid, name: p.name, ok: true, skipped: "added by hand — nothing to pull" };
  if (!p.base_url || !p.key_sealed) return { pid, name: p.name, ok: false, error: "This product has no URL or key." };

  const startedAt = new Date().toISOString();
  const today = utcToday();
  // First pull: the last 12 months. After that: the last 35 days, plus any older day still pending.
  let from = opts.range?.from ?? addDays(today, -((p.last_ok_at ? REPULL_DAYS : BACKFILL_DAYS) - 1));
  const to = opts.range?.to ?? today;
  if (!opts.range && p.last_ok_at) {
    const pending = await oldestPendingDate(pid);
    const floor = addDays(today, -MAX_LOOKBACK_DAYS);
    if (pending && pending < from) from = pending < floor ? floor : pending;
  }
  const fail = async (error: string): Promise<PullOutcome> => {
    await markPullResult(pid, { ok: false, error });
    await recordPull({ pid, startedAt, ok: false, from, to, error, trigger: opts.trigger });
    return { pid, name: p.name, ok: false, error, from, to };
  };

  let apiKey: string;
  try { apiKey = openKey(p.key_sealed); } catch (e) { return fail((e as Error).message); }
  const cleanUrl = cleanBaseUrl(p.base_url);
  if (!cleanUrl.ok) return fail(cleanUrl.error);

  // Fetch and check every window first — nothing is written unless all of them pass.
  const got: Array<{ from: string; to: string; feed: CleanFeed }> = [];
  for (const w of windows(from, to)) {
    const r = await fetchFeed(cleanUrl.url, apiKey, w.from, w.to);
    if (!r.ok) return fail(r.error);
    const c = checkFeed(r.body, { from: w.from, to: w.to, slug: p.slug });
    if (!c.ok) return fail(`The feed for ${w.from} → ${w.to} was rejected: ${c.errors.slice(0, 8).join(" · ")}${c.errors.length > 8 ? ` · and ${c.errors.length - 8} more` : ""}`);
    if (got.length && c.feed.productSlug !== got[0].feed.productSlug) return fail("The feed changed its product.id between windows.");
    got.push({ ...w, feed: c.feed });
  }
  const meta = got[got.length - 1].feed;
  if (!p.slug) {
    const taken = await slugTakenBy(meta.productSlug, pid);
    if (taken) return fail(`Another product ("${taken}") already reports as "${meta.productSlug}" — each product needs its own product.id.`);
  }

  const total: ApplyResult = { added: 0, changed: 0, removed: 0, unchanged: 0 };
  try {
    for (const g of got) {
      const r = await applyRange(pid, g.from, g.to, g.feed.items);
      total.added += r.added; total.changed += r.changed; total.removed += r.removed; total.unchanged += r.unchanged;
    }
  } catch (e) {
    return fail(`Saving the figures failed: ${(e as Error).message}`);
  }
  await markPullResult(pid, { ok: true, feedMeta: { slug: meta.productSlug, name: meta.productName, environment: meta.environment, notes: meta.notes, generatedAt: meta.generatedAt } });
  await recordPull({ pid, startedAt, ok: true, from, to, ...total, trigger: opts.trigger });
  return { pid, name: meta.productName, ok: true, from, to, ...total };
}

/** Checks a product's feed for the last 35 days without storing anything (the "Test" button). */
export async function testFeed(baseUrl: string, apiKey: string, slug: string | null): Promise<{ ok: true; slug: string; name: string; items: number; from: string; to: string } | { ok: false; error: string }> {
  const clean = cleanBaseUrl(baseUrl);
  if (!clean.ok) return clean;
  const to = utcToday(), from = addDays(to, -(REPULL_DAYS - 1));
  const r = await fetchFeed(clean.url, apiKey, from, to);
  if (!r.ok) return r;
  const c = checkFeed(r.body, { from, to, slug });
  if (!c.ok) return { ok: false, error: `The feed was rejected: ${c.errors.slice(0, 8).join(" · ")}${c.errors.length > 8 ? ` · and ${c.errors.length - 8} more` : ""}` };
  return { ok: true, slug: c.feed.productSlug, name: c.feed.productName, items: c.feed.items.length, from, to };
}

/** Pull every enabled product, one after another. */
export async function pullAll(trigger: string): Promise<PullOutcome[]> {
  const products = (await listProducts()).filter((p) => p.kind === "feed" && p.enabled);
  const out: PullOutcome[] = [];
  for (const p of products) {
    try { out.push(await pullProduct(p.pid, { trigger })); }
    catch (e) { out.push({ pid: p.pid, name: p.name, ok: false, error: (e as Error).message }); }
  }
  return out;
}
