/**
 * App-load prefetch buffer for the inbox.
 *
 * Fetches the DEFAULT inbox view's `mode=bootstrap` payload proactively (on app
 * load and when navigating away from the inbox) and holds it in a single, short-
 * lived slot so the first inbox open paints instantly. This is NOT a persistent
 * stale-while-revalidate cache: the slot is TTL-gated and single-use, so the
 * inbox either hydrates from FRESH prefetched data (< TTL) or fetches normally.
 * Stale data is never shown.
 */

export const DEFAULT_VIEW = "base-clients-cherry";
const TTL_MS = 45_000;

export interface InboxBootstrap {
  counts: Record<string, number>;
  total: number;
  firstCategory: string | null;
  leads: Record<string, unknown>[];
  hasMore: boolean;
  clientTags: string[];
}

interface Slot {
  key: string;
  fetchedAt: number;
  promise: Promise<InboxBootstrap | null>;
  data?: InboxBootstrap;
}

let slot: Slot | null = null;

export function bootstrapKey(view: string, client: string): string {
  return `${view}::${client || "all"}`;
}

function buildUrl(view: string, client: string): string {
  const p = new URLSearchParams({ mode: "bootstrap" });
  if (view && view !== "all") p.set("view", view);
  if (client) p.set("client_tag", client);
  return `/api/inbox?${p.toString()}`;
}

/**
 * Kick off a prefetch for (view, client) unless a fresh (or in-flight) slot for
 * the same key already exists. Fire-and-forget.
 */
export function prefetchInbox(view: string = DEFAULT_VIEW, client: string = ""): void {
  const key = bootstrapKey(view, client);
  if (slot && slot.key === key && Date.now() - slot.fetchedAt < TTL_MS) return; // already warm/in-flight
  const promise = fetch(buildUrl(view, client))
    .then((r) => (r.ok ? r.json() : null))
    .then((d: InboxBootstrap | null) => {
      if (d && slot && slot.key === key) slot.data = d;
      return d;
    })
    .catch(() => null);
  slot = { key, fetchedAt: Date.now(), promise };
}

/**
 * Synchronously return already-resolved, fresh prefetched data for (view,
 * client), consuming the slot. Returns null if there's no matching slot, it's
 * expired, or it hasn't resolved yet (in-flight) — the caller then fetches
 * normally. Single-use so nothing stale is ever reused.
 */
export function peekFreshBootstrap(view: string, client: string): InboxBootstrap | null {
  const key = bootstrapKey(view, client);
  if (!slot || slot.key !== key) return null;
  if (Date.now() - slot.fetchedAt >= TTL_MS) { slot = null; return null; }
  if (!slot.data) return null; // in-flight — can't hydrate synchronously
  const data = slot.data;
  slot = null;
  return data;
}
