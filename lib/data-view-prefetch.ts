/**
 * App-load prefetch buffer for the Data View (mirrors lib/inbox-prefetch.ts).
 * Warms the DEFAULT page (no filters, newest first) so the first open paints
 * instantly. TTL-gated: fresh-or-nothing, stale data is never shown.
 */

const TTL_MS = 45_000;
export const DATA_VIEW_DEFAULT_SORT = "created_at.desc";
export const DATA_VIEW_PAGE_SIZE = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface DataViewPage { rows: Record<string, any>[]; page: { hasMore: boolean } }

let slot: { fetchedAt: number; promise: Promise<DataViewPage | null>; data?: DataViewPage } | null = null;

async function fetchDefault(): Promise<DataViewPage | null> {
  try {
    const res = await fetch(`/api/data-view?sort=${DATA_VIEW_DEFAULT_SORT}&limit=${DATA_VIEW_PAGE_SIZE}&offset=0`);
    if (!res.ok) return null;
    return (await res.json()) as DataViewPage;
  } catch {
    return null;
  }
}

/** Kick off (or reuse) a fresh prefetch of the default first page. */
export function prefetchDataView(): void {
  if (slot && Date.now() - slot.fetchedAt < TTL_MS) return;
  const s = { fetchedAt: Date.now(), promise: fetchDefault() } as NonNullable<typeof slot>;
  s.promise.then((d) => { if (d && slot === s) s.data = d; });
  slot = s;
}

/** Synchronously read a FRESH prefetched page, if one resolved. Single-use. */
export function peekDataView(): DataViewPage | null {
  if (!slot || Date.now() - slot.fetchedAt > TTL_MS || !slot.data) return null;
  const d = slot.data;
  slot = null; // single-use: the page revalidates on its own after hydrating
  return d;
}
