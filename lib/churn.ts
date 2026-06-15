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
