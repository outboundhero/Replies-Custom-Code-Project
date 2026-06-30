/**
 * Churned-client gate. The set of churned client tags (Status="Churned" AND a
 * Churn Date in the Client Tracker sheet) is synced into the Turso
 * `churned_clients` table by /api/cron/sync-churned-clients. Everything that
 * should skip churned clients (nurture page, backfill, auto-push, sync) reads
 * the set from here — cheap, with a short in-process cache.
 */
import db from "@/lib/db";

let cache: { set: Set<string>; ts: number } | null = null;
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

export function invalidateChurnCache() { cache = null; }

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
  const map = new Map<string, string | null>();
  try {
    const res = await db.execute("SELECT client_tag, churn_date FROM churned_clients");
    for (const r of res.rows) map.set(String(r.client_tag).toUpperCase(), (r.churn_date as string) ?? null);
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
 * Rebuild the Turso `churned_clients` table from the Client Tracker sheet —
 * Status="Churned" AND Churn Date on/before today (future dates stay active).
 * Stores the churn date too. Shared by the cron + the Automation-tab sync button.
 */
export async function rebuildChurnedClients(): Promise<{ count: number; tags: string[] }> {
  const { fetchChurnedClients } = await import("@/lib/google-sheets");
  const churned = await fetchChurnedClients();
  await db.execute("CREATE TABLE IF NOT EXISTS churned_clients (client_tag TEXT PRIMARY KEY, churn_date TEXT, synced_at TEXT)");
  // Upgrade older tables that predate the churn_date column (no-op if it exists).
  try { await db.execute("ALTER TABLE churned_clients ADD COLUMN churn_date TEXT"); } catch { /* already there */ }
  const now = new Date().toISOString();
  await db.execute("DELETE FROM churned_clients"); // replace the whole set (clients can un-churn)
  for (const c of churned) {
    await db.execute({
      sql: "INSERT OR IGNORE INTO churned_clients (client_tag, churn_date, synced_at) VALUES (?, ?, ?)",
      args: [c.tag, c.churnDate, now],
    });
  }
  invalidateChurnCache();
  const tags = [...new Set(churned.map((c) => c.tag))].sort();
  return { count: tags.length, tags };
}
