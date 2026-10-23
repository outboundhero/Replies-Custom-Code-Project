/**
 * What waits for a client's Hard Reset or Nurture reset (both are rows in `hard_reset`).
 *
 * Nurture (routing, the batch cloner, the map refresh, the DM4PM hand-off, a manual
 * push) holds while a reset is unfinished — under way, or stopped part-way — and
 * for 15 minutes after one finishes (other processes' campaign caches — the map
 * refresh keeps one for 10 minutes — catch up with the new campaigns by then).
 * Without this, leads could go into old campaigns about to be archived, the
 * cloner could copy them, or the map refresh could point nurture back at them.
 * Held leads stay queued and go once it's over.
 */
import db from "@/lib/db";

const OPEN = "status IN ('creating', 'attaching', 'repointing', 'emptying', 'archiving', 'cancelling', 'failed')";
const HOLD_AFTER_MS = 15 * 60_000;
const CACHE_MS = 30_000;
let cache: { at: number; tags: Set<string> } | null = null;

/** Is this client's nurture on hold for a Hard Reset? (No reset table yet, or it can't be read = no.) */
export async function heldByHardReset(tag: string): Promise<boolean> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    try {
      const since = new Date(Date.now() - HOLD_AFTER_MS).toISOString();
      const r = await db.execute({
        sql: `SELECT DISTINCT client_tag FROM hard_reset WHERE ${OPEN} OR (status = 'done' AND finished_at > ?)`,
        args: [since],
      });
      cache = { at: Date.now(), tags: new Set(r.rows.map((x) => String(x.client_tag).toUpperCase())) };
    } catch {
      cache = { at: Date.now(), tags: new Set() };
    }
  }
  return cache.tags.has(String(tag || "").toUpperCase());
}

/** The client's unfinished Hard Reset (under way or stopped part-way), read now; null when none (or unreadable). */
export async function unfinishedHardReset(tag: string): Promise<{ id: number; status: string } | null> {
  try {
    const r = await db.execute({ sql: `SELECT id, status FROM hard_reset WHERE client_tag = ? AND ${OPEN} ORDER BY id DESC LIMIT 1`, args: [String(tag || "").toUpperCase()] });
    return r.rows.length ? { id: Number(r.rows[0].id), status: String(r.rows[0].status) } : null;
  } catch {
    return null;
  }
}
