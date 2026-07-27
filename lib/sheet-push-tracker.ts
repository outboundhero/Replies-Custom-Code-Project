/**
 * Durable tracking of lead-sheet push failures so none is ever silently lost.
 *
 * When a positive lead (Meeting-Ready / Follow Up / Interested / Referral Given)
 * is marked but the push to the client's tracking sheet fails, we record it here
 * (in Turso). It then shows on the Reply Router "Sheet Pushes" dashboard where
 * the team retries until it succeeds — a successful push auto-clears the row —
 * or dismisses it manually. A cron also auto-retries pending rows so transient
 * Google API blips self-heal without anyone touching them.
 */
import db from "@/lib/db";

let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await db.execute(`CREATE TABLE IF NOT EXISTS sheet_push_failures (
    reply_id INTEGER PRIMARY KEY,
    client_tag TEXT,
    lead_email TEXT,
    lead_name TEXT,
    category TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    first_failed_at TEXT,
    last_attempt_at TEXT
  )`);
  ensured = true;
}

export interface SheetPushFailure {
  reply_id: number;
  client_tag: string | null;
  lead_email: string | null;
  lead_name: string | null;
  category: string | null;
  error: string | null;
  attempts: number;
  status: string;
  first_failed_at: string | null;
  last_attempt_at: string | null;
}

export async function recordSheetPushFailure(f: {
  replyId: number; clientTag?: string | null; leadEmail?: string | null;
  leadName?: string | null; category?: string | null; error: string;
}): Promise<void> {
  await ensureTable();
  const now = new Date().toISOString();
  // Re-opens a previously-dismissed row if the same lead fails again.
  await db.execute({
    sql: `INSERT INTO sheet_push_failures
            (reply_id, client_tag, lead_email, lead_name, category, error, attempts, status, first_failed_at, last_attempt_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)
          ON CONFLICT(reply_id) DO UPDATE SET
            client_tag = excluded.client_tag,
            lead_email = excluded.lead_email,
            lead_name = excluded.lead_name,
            category = excluded.category,
            error = excluded.error,
            attempts = sheet_push_failures.attempts + 1,
            status = 'pending',
            last_attempt_at = excluded.last_attempt_at`,
    args: [f.replyId, f.clientTag ?? null, f.leadEmail ?? null, f.leadName ?? null, f.category ?? null, f.error, now, now],
  });
}

/** Remove a failure once the push has succeeded. */
export async function clearSheetPushFailure(replyId: number): Promise<void> {
  await ensureTable();
  await db.execute({ sql: "DELETE FROM sheet_push_failures WHERE reply_id = ?", args: [replyId] });
}

/** Manually dismiss a failure (kept for audit, hidden from the pending list). */
export async function dismissSheetPushFailure(replyId: number): Promise<void> {
  await ensureTable();
  await db.execute({
    sql: "UPDATE sheet_push_failures SET status = 'dismissed', last_attempt_at = ? WHERE reply_id = ?",
    args: [new Date().toISOString(), replyId],
  });
}

export async function listSheetPushFailures(status = "pending"): Promise<SheetPushFailure[]> {
  await ensureTable();
  const r = await db.execute({
    sql: "SELECT * FROM sheet_push_failures WHERE status = ? ORDER BY first_failed_at DESC",
    args: [status],
  });
  return r.rows as unknown as SheetPushFailure[];
}

export async function countPendingSheetPushFailures(): Promise<number> {
  await ensureTable();
  const r = await db.execute("SELECT COUNT(*) AS c FROM sheet_push_failures WHERE status = 'pending'");
  return Number((r.rows[0] as unknown as { c: number }).c) || 0;
}
