/**
 * Per-campaign progress the campaign caches keep for the "where contacts sit"
 * view: leads contacted, how far through its sequence the campaign is, and
 * distinct replies. Added to tables that predate them (a no-op once there).
 */
import db from "@/lib/db";

const COLUMNS: Array<[string, string]> = [["contacted", "INTEGER"], ["completion", "REAL"], ["replied", "INTEGER"]];
const TABLES = ["nurture_campaigns_cache", "main_campaigns_cache"];

async function columnsOf(table: string): Promise<Set<string>> {
  const r = await db.execute(`PRAGMA table_info(${table})`);
  return new Set(r.rows.map((x) => String(x.name)));
}

let ready: Promise<void> | null = null;
export function ensureStageColumns(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      for (const table of TABLES) {
        const have = await columnsOf(table);
        if (!have.size) continue; // the table isn't there yet — its cron creates it
        for (const [col, type] of COLUMNS) {
          if (have.has(col)) continue;
          try {
            await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
          } catch (e) {
            // Another server may have added it a moment ago; anything else is a real failure.
            if (!(await columnsOf(table)).has(col)) throw e;
          }
        }
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** Whether the progress columns are there (readers fall back to totals when they aren't). */
export async function hasStageColumns(): Promise<boolean> {
  try {
    for (const table of TABLES) {
      const have = await columnsOf(table);
      if (!COLUMNS.every(([c]) => have.has(c))) return false;
    }
    return true;
  } catch { return false; }
}
