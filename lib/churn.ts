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

export async function getChurnedTags(): Promise<Set<string>> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.set;
  const set = new Set<string>();
  try {
    const res = await db.execute("SELECT client_tag FROM churned_clients");
    for (const r of res.rows) set.add(String(r.client_tag).toUpperCase());
  } catch {
    // Table not created yet (pre-migration) → treat nobody as churned.
  }
  cache = { set, ts: Date.now() };
  return set;
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
  const map = new Map<string, string | null>();
  try {
    const res = await db.execute("SELECT client_tag, churn_date FROM churned_clients");
    for (const r of res.rows) map.set(String(r.client_tag).toUpperCase(), (r.churn_date as string) ?? null);
    clientsCache = { map, ts: Date.now() };
    return map;
  } catch {
    try {
      const res = await db.execute("SELECT client_tag FROM churned_clients");
      for (const r of res.rows) map.set(String(r.client_tag).toUpperCase(), null);
    } catch { /* table missing → empty */ }
    return map;
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
  const [fromGroups, fromTracker] = await Promise.all([
    fetchChurnedFromGroups().catch(() => []),
    fetchChurnedClients().catch(() => []),
  ]);
  const byTag = new Map<string, string>(); // tag → churn date (first non-empty wins)
  for (const c of [...fromGroups, ...fromTracker]) {
    const tag = c.tag.toUpperCase();
    if (!byTag.has(tag) || (!byTag.get(tag) && c.churnDate)) byTag.set(tag, c.churnDate || "");
  }
  await db.execute("CREATE TABLE IF NOT EXISTS churned_clients (client_tag TEXT PRIMARY KEY, churn_date TEXT, synced_at TEXT)");
  // Upgrade older tables that predate the churn_date column (no-op if it exists).
  try { await db.execute("ALTER TABLE churned_clients ADD COLUMN churn_date TEXT"); } catch { /* already there */ }
  const now = new Date().toISOString();
  await db.execute("DELETE FROM churned_clients"); // replace the whole set (clients can un-churn)
  for (const [tag, churnDate] of byTag) {
    await db.execute({
      sql: "INSERT OR IGNORE INTO churned_clients (client_tag, churn_date, synced_at) VALUES (?, ?, ?)",
      args: [tag, churnDate, now],
    });
  }
  invalidateChurnCache();
  const tags = [...byTag.keys()].sort();
  return { count: tags.length, tags };
}
