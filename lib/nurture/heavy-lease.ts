/**
 * One system-wide "heavy query" lease (Turso), so at most ONE heavy Nurture
 * query runs on the shared Supabase database at a time — across every server,
 * cron and button. Heavy = per-tag stats (nurture_tag_stats) and the
 * every-queue suffix search (nurture_tags_with_suffix): each can scan tens of
 * thousands to millions of rows, and running them side by side starved the
 * inbox's queries into timeouts (2026-10-09).
 *
 * The lease expires on its own (TTL), so a crashed holder can't block forever;
 * long jobs renew it between steps.
 */
import db from "@/lib/db";

let ready: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!ready) {
    ready = db.execute("CREATE TABLE IF NOT EXISTS nurture_heavy_lease (id INTEGER PRIMARY KEY, holder TEXT, expires_at INTEGER)")
      .then(() => undefined).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** Take the lease if it's free (or expired). Returns false if someone else holds it. */
export async function acquireHeavyLease(holder: string, ttlMs: number): Promise<boolean> {
  await ensureTable();
  const now = Date.now();
  const r = await db.execute({
    sql: `INSERT INTO nurture_heavy_lease (id, holder, expires_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
          WHERE nurture_heavy_lease.expires_at < ? OR nurture_heavy_lease.holder = excluded.holder`,
    args: [holder, now + ttlMs, now],
  });
  return r.rowsAffected > 0;
}

/** Extend a lease we hold (false if we lost it). */
export async function renewHeavyLease(holder: string, ttlMs: number): Promise<boolean> {
  await ensureTable();
  const r = await db.execute({
    sql: "UPDATE nurture_heavy_lease SET expires_at = ? WHERE id = 1 AND holder = ?",
    args: [Date.now() + ttlMs, holder],
  });
  return r.rowsAffected > 0;
}

export async function releaseHeavyLease(holder: string): Promise<void> {
  await ensureTable();
  await db.execute({ sql: "UPDATE nurture_heavy_lease SET expires_at = 0 WHERE id = 1 AND holder = ?", args: [holder] });
}

export const leaseHolder = (what: string) => `${what}:${Math.random().toString(36).slice(2, 10)}`;
