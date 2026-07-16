/**
 * Tiny generic in-process cache for read-mostly API routes (config, lists).
 *
 * Same idea as lib/inbox-cache.ts but general-purpose: the first request in a
 * TTL window pays the DB cost, everyone else on the same warm serverless
 * instance gets an instant response. Config tables (clients, sections,
 * qualification rules, users) change rarely, so a short TTL is invisible.
 *
 * Invalidation is namespaced: a mutate calls `bumpVersion("config")`, and cache
 * keys embed the namespace version, so the next read misses and refreshes —
 * without clearing unrelated namespaces.
 *
 * Note: in-process only (per warm lambda). It doesn't survive cold starts or
 * span instances — but on any warm instance it collapses repeat loads, and the
 * underlying queries are parallelized so even a miss is fast.
 */

interface Entry<T> {
  data: T;
  ts: number;
}

const store = new Map<string, Entry<unknown>>();
const versions = new Map<string, number>();

/** Current version for a namespace (0 if never bumped). */
export function nsVersion(ns: string): number {
  return versions.get(ns) ?? 0;
}

/** Invalidate a namespace — the next read on any of its keys misses. */
export function bumpVersion(ns: string): void {
  versions.set(ns, nsVersion(ns) + 1);
}

export function getCached<T>(key: string, ttlMs: number): T | null {
  const e = store.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > ttlMs) {
    store.delete(key);
    return null;
  }
  return e.data as T;
}

export function setCached<T>(key: string, data: T): void {
  store.set(key, { data, ts: Date.now() });
  // Bound memory — key set is tiny, this is defensive.
  if (store.size > 500) {
    const oldest = [...store.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) store.delete(oldest[0]);
  }
}

/**
 * Get-or-compute. Returns the cached value when fresh, otherwise runs `loader`,
 * caches, and returns it. Include a namespace in `key` (e.g. `config:clients`)
 * and, when you want mutate-invalidation, fold `nsVersion(ns)` into the key.
 */
export async function withCache<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const hit = getCached<T>(key, ttlMs);
  if (hit !== null) return hit;
  const data = await loader();
  setCached(key, data);
  return data;
}
