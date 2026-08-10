/**
 * Persistence for the nurture 80% activation gate — the "fired" flag + the
 * gate's rotation cursor. Kept in its own module (no Bison / enable-sending
 * imports) so every activation path can call `isFired()` without a circular
 * dependency. See lib/nurture/activation-gate.ts for the gate logic.
 *
 *   nurture_activation   — presence of a row = the client is fired (permanent).
 *   nurture_gate_checks  — last time the gate evaluated a tag (oldest-first rotation).
 */
import db from "@/lib/db";

let tablesReady = false;
export async function ensureActivationTables(): Promise<void> {
  if (tablesReady) return;
  await db.execute(
    "CREATE TABLE IF NOT EXISTS nurture_activation (client_tag TEXT PRIMARY KEY, activated_at TEXT, main_total INTEGER, main_contacted INTEGER)",
  );
  await db.execute(
    "CREATE TABLE IF NOT EXISTS nurture_gate_checks (client_tag TEXT PRIMARY KEY, checked_at TEXT)",
  );
  tablesReady = true;
}

/** True once a client has been fired — the permanent, fire-once flag. */
export async function isFired(tag: string | null | undefined): Promise<boolean> {
  const TAG = String(tag ?? "").toUpperCase();
  if (!TAG) return false;
  await ensureActivationTables();
  const r = await db.execute({
    sql: "SELECT client_tag FROM nurture_activation WHERE client_tag = ?",
    args: [TAG],
  });
  return r.rows.length > 0;
}

export async function markFired(tag: string, total: number, contacted: number): Promise<void> {
  await ensureActivationTables();
  await db.execute({
    sql: "INSERT OR IGNORE INTO nurture_activation (client_tag, activated_at, main_total, main_contacted) VALUES (?, ?, ?, ?)",
    args: [tag.toUpperCase(), new Date().toISOString(), total, contacted],
  });
}

export async function recordGateCheck(tag: string): Promise<void> {
  await ensureActivationTables();
  await db.execute({
    sql: "INSERT OR REPLACE INTO nurture_gate_checks (client_tag, checked_at) VALUES (?, ?)",
    args: [tag.toUpperCase(), new Date().toISOString()],
  });
}

export async function loadLastGateChecks(): Promise<Map<string, string>> {
  await ensureActivationTables();
  const r = await db.execute("SELECT client_tag, checked_at FROM nurture_gate_checks");
  const m = new Map<string, string>();
  for (const row of r.rows) m.set(String(row.client_tag), String(row.checked_at ?? ""));
  return m;
}
