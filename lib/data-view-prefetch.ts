/**
 * App-load prefetch buffer for the Data View (mirrors lib/inbox-prefetch.ts).
 * Warms the DEFAULT page (the user's default category, newest first) so the
 * first open paints instantly. TTL-gated: fresh-or-nothing, stale data is never
 * shown.
 */

const TTL_MS = 45_000;
export const DATA_VIEW_DEFAULT_SORT = "created_at.desc";
export const DATA_VIEW_PAGE_SIZE = 100;

/** The Category filter the Data View opens with. Internal inbox managers start
 *  every visit on the Open Response queue (they can change it; it resets on the
 *  next visit). Admins open unfiltered. */
export function dataViewDefaultCategory(session: { role?: string | null; allowedClientTags?: string[] | null } | null): string {
  const scoped = !!session?.allowedClientTags && session.allowedClientTags.length > 0;
  return session?.role === "inbox_manager" && !scoped ? "Open Response" : "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface DataViewPage { rows: Record<string, any>[]; page: { hasMore: boolean } }

let slot: { fetchedAt: number; category: string; promise: Promise<DataViewPage | null>; data?: DataViewPage } | null = null;

async function fetchDefault(category: string): Promise<DataViewPage | null> {
  try {
    const cat = category ? `&category=${encodeURIComponent(category)}` : "";
    const res = await fetch(`/api/data-view?sort=${DATA_VIEW_DEFAULT_SORT}&limit=${DATA_VIEW_PAGE_SIZE}&offset=0${cat}`);
    if (!res.ok) return null;
    return (await res.json()) as DataViewPage;
  } catch {
    return null;
  }
}

/** Kick off (or reuse) a fresh prefetch of the default first page. */
export function prefetchDataView(category = ""): void {
  if (slot && slot.category === category && Date.now() - slot.fetchedAt < TTL_MS) return;
  const s = { fetchedAt: Date.now(), category, promise: fetchDefault(category) } as NonNullable<typeof slot>;
  s.promise.then((d) => { if (d && slot === s) s.data = d; });
  slot = s;
}

/** Synchronously read a FRESH prefetched page for this default category, if one
 *  resolved. Single-use. */
export function peekDataView(category = ""): DataViewPage | null {
  if (!slot || slot.category !== category || Date.now() - slot.fetchedAt > TTL_MS || !slot.data) return null;
  const d = slot.data;
  slot = null; // single-use: the page revalidates on its own after hydrating
  return d;
}
