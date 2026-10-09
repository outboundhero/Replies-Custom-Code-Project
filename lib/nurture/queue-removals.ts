/**
 * Turso record of every Nurture queue removal (the redesign's Remove buttons),
 * holding the exact rows each one flagged so Undo can reverse just that removal.
 * A record is written as "pending" BEFORE the database change and completed
 * after, so a crash mid-way can never leave skipped rows without a record.
 */
import db from "@/lib/db";

let ready: Promise<void> | null = null;
export function ensureRemovalsTable(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await db.execute(
        `CREATE TABLE IF NOT EXISTS nurture_queue_removals (
          id INTEGER PRIMARY KEY AUTOINCREMENT, client_tag TEXT NOT NULL, removed_at TEXT NOT NULL,
          removed_by TEXT, mode TEXT, contacts INTEGER, row_count INTEGER,
          ids_json TEXT, emails_json TEXT, filters_json TEXT,
          restored_at TEXT, restored_by TEXT, restored_rows INTEGER,
          status TEXT, error TEXT
        )`,
      );
      // Columns added after the first version of the table.
      for (const col of ["status TEXT", "error TEXT"]) {
        try { await db.execute(`ALTER TABLE nurture_queue_removals ADD COLUMN ${col}`); } catch { /* already there */ }
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** A removal can be undone once, only if we know exactly which rows it flagged. */
export function isUndoable(r: { status?: unknown; ids_json?: unknown; restored_at?: unknown; row_count?: unknown }): boolean {
  return (r.status == null || r.status === "done") && !!r.ids_json && !r.restored_at && Number(r.row_count) > 0;
}
