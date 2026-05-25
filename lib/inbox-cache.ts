/**
 * Tiny in-process cache for the /api/inbox counts + client_tags responses.
 *
 * Why this exists: counts mode fires 20 parallel HEAD count queries on the
 * replies table. Even with `count: 'estimated'` (planner-based, O(1) per
 * query), 20 round trips through PgBouncer on a fresh page load is the
 * single biggest source of perceived inbox latency.
 *
 * With this cache: the first user in a 60-second window pays the cost,
 * everyone else gets an instant response. Realtime INSERTs on the inbox
 * page already update counts client-side, so the 60s staleness is invisible.
 *
 * Cache invalidation: any /api/inbox/mutate call bumps the global version
 * counter via `bumpCacheVersion()`. The cache key includes the version, so
 * a mutate effectively flushes the cache for the next read.
 */

interface CacheEntry<T> {
  data: T;
  ts: number;
}

const buckets = new Map<string, CacheEntry<unknown>>();

// Bumped on any inbox mutate; included in cache keys so a mutate forces a
// fresh read on the next request.
let version = 0;

export function getCacheVersion(): number {
  return version;
}

export function bumpCacheVersion(): void {
  version++;
}

export function getInboxCache<T>(key: string, ttlMs: number): T | null {
  const entry = buckets.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlMs) {
    buckets.delete(key);
    return null;
  }
  return entry.data as T;
}

export function setInboxCache<T>(key: string, data: T): void {
  buckets.set(key, { data, ts: Date.now() });
  // Keep memory bounded — the cache key set is small (one per unique filter
  // combo per user scope) so this is mostly defensive.
  if (buckets.size > 500) {
    const oldest = [...buckets.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) buckets.delete(oldest[0]);
  }
}
