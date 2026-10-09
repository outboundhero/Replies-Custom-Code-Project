/**
 * Browser-side cache for Nurture queue pages, so the Queue tab paints
 * instantly: the first page arrives with the client page (cached on the server
 * with the client's stats), the next page is prefetched after each load
 * (smaller queues only), and revisiting a page/filter shows the cached copy
 * while a fresh one loads. Lives for the browser session (module scope
 * survives client navigation).
 */
export interface QueueContact {
  email: string; name: string | null; company: string | null; website: string | null; tld: string | null;
  source: string; esp: string; espResolved: boolean; triggerAt: string; eligibleAt: string;
  isEligible: boolean; isReady: boolean; rows: number; overlapTags: string[];
}
export interface QueueResult { total: number; contacts: QueueContact[]; at: number }
export interface QueueFilterValues { search?: string; email?: string; web?: string; source?: string; tld?: string; overlap?: boolean }

export const QUEUE_PAGE = 50;
const FRESH_MS = 20_000;     // newer than this → no refetch needed
const MAX_ENTRIES = 200;

const cache = new Map<string, QueueResult>();
const inflight = new Map<string, Promise<QueueResult>>();

/** Stable query string for a tag + filters + offset (also the cache key). */
export function queueQuery(tag: string, f: QueueFilterValues = {}, offset = 0): string {
  const p = new URLSearchParams({ tag });
  if (f.search?.trim()) p.set("search", f.search.trim());
  if (f.email?.trim()) p.set("email", f.email.trim());
  if (f.web?.trim()) p.set("web", f.web.trim());
  if (f.source) p.set("source", f.source);
  if (f.tld) p.set("tld", f.tld);
  if (f.overlap) p.set("overlap", "1");
  p.set("limit", String(QUEUE_PAGE));
  p.set("offset", String(offset));
  return p.toString();
}

export function getCachedQueue(q: string): QueueResult | null {
  return cache.get(q) ?? null;
}
export const isFresh = (r: QueueResult | null) => !!r && Date.now() - r.at < FRESH_MS;

/** Fetch one page (deduped; the result is cached). */
export function fetchQueue(q: string): Promise<QueueResult> {
  const running = inflight.get(q);
  if (running) return running;
  const self: { p?: Promise<QueueResult> } = {};
  const p = (async () => {
    const r = await fetch(`/api/nurture/queue?${q}`, { cache: "no-store" });
    if (r.redirected || r.status === 401) { window.location.href = "/login"; throw new Error("Signed out"); }
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    const res: QueueResult = { total: Number(d.total) || 0, contacts: d.contacts || [], at: Date.now() };
    // Only cache if this fetch wasn't dropped mid-flight (a remove/undo happened).
    if (inflight.get(q) === self.p) {
      cache.set(q, res);
      if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    }
    return res;
  })().finally(() => { if (inflight.get(q) === self.p) inflight.delete(q); });
  self.p = p;
  inflight.set(q, p);
  return p;
}

/** Warm a page in the background (no-op if a fresh copy is cached). */
export function prefetchQueuePage(tag: string, f: QueueFilterValues = {}, offset = 0): void {
  const q = queueQuery(tag, f, offset);
  if (isFresh(cache.get(q) ?? null)) return;
  void fetchQueue(q).catch(() => { /* best-effort */ });
}

/** Forget every cached page for a tag (after a remove / undo). */
export function dropQueueCache(tag: string): void {
  const prefix = new URLSearchParams({ tag }).toString() + "&";
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
  for (const k of [...inflight.keys()]) if (k.startsWith(prefix)) inflight.delete(k);
}
