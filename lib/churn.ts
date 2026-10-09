/**
 * Churned-client gate. The set of churned client tags (Status="Churned" AND a
 * Churn Date that has PASSED, read from the "Groups" tab — the single source of
 * truth) is synced into the Turso `churned_clients` table by the client-directory
 * sync (cron + the Move-Leads "Sync from sheet" button). Everything that should
 * skip churned clients (nurture page, backfill, auto-push, sync) reads the set
 * from here — cheap, with a short in-process cache.
 */
import db from "@/lib/db";

let cache: { set: Set<string>; ts: number } | null = null;
let clientsCache: { map: Map<string, string | null>; ts: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

/**
 * Fails CLOSED: if the table can't be read, the last known set is reused, and
 * with no known set it throws — callers then skip their run rather than treat
 * every churned client as active (which could resume their campaigns).
 */
export async function getChurnedTags(): Promise<Set<string>> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.set;
  try {
    const res = await db.execute("SELECT client_tag FROM churned_clients");
    const set = new Set<string>();
    for (const r of res.rows) set.add(String(r.client_tag).toUpperCase());
    cache = { set, ts: Date.now() };
    return set;
  } catch (e) {
    if (cache) return cache.set; // stale but safe
    throw new Error(`churned clients unavailable: ${(e as Error).message}`);
  }
}

export function invalidateChurnCache() { cache = null; clientsCache = null; }

/** True when this tag is a churned client (case-insensitive). */
export async function isChurned(tag: string | null | undefined): Promise<boolean> {
  if (!tag) return false;
  return (await getChurnedTags()).has(tag.toUpperCase());
}

/**
 * Map of churned client tag → churn date (the sheet's date string, or null if
 * the churn_date column hasn't been added/populated yet). Used by the Automation
 * tab to show WHEN each client churned. Falls back to tags-only if the column is
 * missing so it always returns the full churned set.
 */
export async function getChurnedClients(): Promise<Map<string, string | null>> {
  if (clientsCache && Date.now() - clientsCache.ts < TTL_MS) return clientsCache.map;
  try {
    const res = await db.execute("SELECT client_tag, churn_date FROM churned_clients");
    const map = new Map<string, string | null>();
    for (const r of res.rows) map.set(String(r.client_tag).toUpperCase(), (r.churn_date as string) ?? null);
    clientsCache = { map, ts: Date.now() };
    return map;
  } catch (e) {
    if (clientsCache) return clientsCache.map; // stale but safe (fails closed, like getChurnedTags)
    throw new Error(`churned clients unavailable: ${(e as Error).message}`);
  }
}

/**
 * Rebuild the Turso `churned_clients` table from the "Groups" tab (the single
 * source of truth) — Status="Churned" AND Churn Date on/before today (future
 * dates stay active). Stores the churn date too. Shared by the cron, the manual
 * sync button, and the Automation-tab sync button.
 */
export async function rebuildChurnedClients(): Promise<{ count: number; tags: string[] }> {
  const { fetchChurnedFromGroups, fetchChurnedClients } = await import("@/lib/google-sheets");
  // Churn is DATE-BASED in BOTH tabs — Status~"Churn" AND a Churn Date on/before
  // today (a FUTURE date means scheduled-to-churn but still active; no date means
  // waitlisted/returning, also active). Read the Groups tab AND the Client Tracker
  // tab and union them: a client removed from the Groups tab when it offboarded
  // (e.g. SQFT) is still listed churned-with-a-passed-date in the Client Tracker.
  // Both tabs must read cleanly: a failed read used to count as "nobody churned"
  // and wiped the table, so churned clients looked active (campaign activation
  // and auto-push could resume them). Any error now aborts and keeps the table.
  const [fromGroups, fromTracker] = await Promise.all([fetchChurnedFromGroups(), fetchChurnedClients()]);
  const byTag = new Map<string, string>(); // tag → churn date (first non-empty wins)
  for (const c of [...fromGroups, ...fromTracker]) {
    const tag = c.tag.toUpperCase();
    if (!byTag.has(tag) || (!byTag.get(tag) && c.churnDate)) byTag.set(tag, c.churnDate || "");
  }
  await db.execute("CREATE TABLE IF NOT EXISTS churned_clients (client_tag TEXT PRIMARY KEY, churn_date TEXT, synced_at TEXT)");
  // Upgrade older tables that predate the churn_date column (no-op if it exists).
  try { await db.execute("ALTER TABLE churned_clients ADD COLUMN churn_date TEXT"); } catch { /* already there */ }
  // Sanity guard: an empty result, or one that drops >30% of the current churned
  // clients at once, is almost certainly a read problem (a renamed column, an
  // empty tab) — refuse instead of un-churning them all.
  const existing = await db.execute("SELECT COUNT(*) AS n FROM churned_clients");
  const before = Number(existing.rows[0]?.n) || 0;
  if (before > 0 && (byTag.size === 0 || byTag.size < before * 0.7)) {
    throw new Error(`churn sync refused: sheet now lists ${byTag.size} churned clients vs ${before} stored — check the sheet (no changes made)`);
  }
  const now = new Date().toISOString();
  // Replace the whole set (clients can un-churn) in ONE transaction, so no
  // reader ever sees an empty or half-written list.
  await db.batch([
    "DELETE FROM churned_clients",
    ...[...byTag].map(([tag, churnDate]) => ({
      sql: "INSERT OR IGNORE INTO churned_clients (client_tag, churn_date, synced_at) VALUES (?, ?, ?)",
      args: [tag, churnDate, now],
    })),
  ], "write");
  invalidateChurnCache();
  const tags = [...byTag.keys()].sort();
  return { count: tags.length, tags };
}
