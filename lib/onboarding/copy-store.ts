/**
 * The email copy library (Turso). One row per saved VERSION of a client type's
 * copy; the newest is the one in use. Nothing is ever overwritten, so any
 * earlier version can be looked at or restored (a restore saves it again as a
 * new version).
 *
 * A save says which version it was editing: if someone saved in between, it
 * is refused rather than silently replacing their work.
 *
 * Cleaning starts from Clay's copy (lib/onboarding/copy-seed.ts) the first
 * time the library is read; the other types start empty and are filled in
 * the editor.
 */
import { randomUUID } from "crypto";
import db from "@/lib/db";
import { CLIENT_TYPES, checkSequence, cleanSequence, type ClientTypeKey, type CopySequence } from "@/lib/onboarding/copy-model";
import { CLEANING_SEED, CLAY_SOURCE } from "@/lib/onboarding/copy-seed";

export interface CopyVersion {
  id: string;
  clientType: ClientTypeKey;
  version: number;
  sequence: CopySequence;
  savedBy: string | null;
  savedAt: string;
  note: string | null;
}

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  ready ??= (async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS onboarding_email_copy (
      id TEXT PRIMARY KEY,
      client_type TEXT NOT NULL,
      version INTEGER NOT NULL,
      steps TEXT NOT NULL,
      saved_by TEXT,
      saved_at TEXT NOT NULL,
      note TEXT
    )`);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_email_copy_version ON onboarding_email_copy(client_type, version)`);
    // Cleaning starts from Clay's copy. INSERT OR IGNORE on the unique version
    // index: two first readers can't both seed it.
    await db.execute({
      sql: `INSERT OR IGNORE INTO onboarding_email_copy (id, client_type, version, steps, saved_by, saved_at, note)
            SELECT ?, 'cleaning', 1, ?, NULL, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM onboarding_email_copy WHERE client_type = 'cleaning')`,
      args: [randomUUID(), JSON.stringify(CLEANING_SEED), new Date().toISOString(), `Started from ${CLAY_SOURCE}`],
    });
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

const rowToVersion = (r: Record<string, unknown>): CopyVersion => ({
  id: String(r.id),
  clientType: String(r.client_type) as ClientTypeKey,
  version: Number(r.version),
  sequence: (cleanSequence(JSON.parse(String(r.steps))) ?? { steps: [] }),
  savedBy: (r.saved_by as string | null) ?? null,
  savedAt: String(r.saved_at),
  note: (r.note as string | null) ?? null,
});

/** The copy in use for every client type (null = not written yet), plus each type's version list. */
export async function readLibrary(): Promise<{ type: ClientTypeKey; current: CopyVersion | null; versions: Omit<CopyVersion, "sequence">[] }[]> {
  await ensure();
  // The full text only for the version in use; the list of earlier versions without it.
  const [list, latest] = await Promise.all([
    db.execute("SELECT id, client_type, version, saved_by, saved_at, note FROM onboarding_email_copy ORDER BY client_type, version DESC"),
    db.execute(`SELECT c.id, c.client_type, c.version, c.steps, c.saved_by, c.saved_at, c.note
                FROM onboarding_email_copy c
                JOIN (SELECT client_type, MAX(version) AS v FROM onboarding_email_copy GROUP BY client_type) m
                  ON m.client_type = c.client_type AND m.v = c.version`),
  ]);
  const current = new Map(latest.rows.map((x) => { const v = rowToVersion(x as Record<string, unknown>); return [v.clientType, v] as const; }));
  return CLIENT_TYPES.map((t) => ({
    type: t.key,
    current: current.get(t.key) ?? null,
    versions: list.rows
      .filter((r) => String(r.client_type) === t.key)
      .map((r) => ({ id: String(r.id), clientType: t.key, version: Number(r.version), savedBy: (r.saved_by as string | null) ?? null, savedAt: String(r.saved_at), note: (r.note as string | null) ?? null })),
  }));
}

/** One saved version, for looking at or restoring. */
export async function readVersion(clientType: ClientTypeKey, version: number): Promise<CopyVersion | null> {
  await ensure();
  const r = await db.execute({ sql: "SELECT id, client_type, version, steps, saved_by, saved_at, note FROM onboarding_email_copy WHERE client_type = ? AND version = ?", args: [clientType, version] });
  return r.rows[0] ? rowToVersion(r.rows[0] as Record<string, unknown>) : null;
}

/** The copy in use for one type (what campaign creation reads). */
export async function currentCopy(clientType: ClientTypeKey): Promise<CopyVersion | null> {
  await ensure();
  const r = await db.execute({ sql: "SELECT id, client_type, version, steps, saved_by, saved_at, note FROM onboarding_email_copy WHERE client_type = ? ORDER BY version DESC LIMIT 1", args: [clientType] });
  return r.rows[0] ? rowToVersion(r.rows[0] as Record<string, unknown>) : null;
}

export type SaveResult =
  | { ok: true; version: CopyVersion }
  | { ok: false; reason: "invalid"; errors: string[] }
  | { ok: false; reason: "conflict"; current: number | null; message: string };

/**
 * Save a new version. `baseVersion` is the version the editor started from
 * (null when there was none); if the newest is different, someone else saved
 * meanwhile and this is refused.
 */
export async function saveCopy(clientType: ClientTypeKey, sequence: CopySequence, by: string | null, note: string | null, baseVersion: number | null): Promise<SaveResult> {
  await ensure();
  const check = checkSequence(sequence);
  if (check.errors.length) return { ok: false, reason: "invalid", errors: check.errors.map((e) => `Email ${e.step}: ${e.message}`) };
  const latest = await currentCopy(clientType);
  const latestVersion = latest?.version ?? null;
  if (latestVersion !== baseVersion) {
    return { ok: false, reason: "conflict", current: latestVersion, message: `This copy was saved by ${latest?.savedBy ?? "someone"} while you were editing (now version ${latestVersion}). Reload it, then make your changes again.` };
  }
  const next = (latestVersion ?? 0) + 1;
  const row = { id: randomUUID(), savedAt: new Date().toISOString() };
  try {
    await db.execute({
      sql: "INSERT INTO onboarding_email_copy (id, client_type, version, steps, saved_by, saved_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [row.id, clientType, next, JSON.stringify(sequence), by, row.savedAt, note?.trim() ? note.trim().slice(0, 500) : null],
    });
  } catch (e) {
    // The unique (type, version) index: another save took this number a moment ago.
    if (/unique|constraint/i.test((e as Error).message)) return { ok: false, reason: "conflict", current: next, message: "Someone saved this copy at the same moment. Reload it, then make your changes again." };
    throw e;
  }
  return { ok: true, version: { id: row.id, clientType, version: next, sequence, savedBy: by, savedAt: row.savedAt, note: note?.trim() || null } };
}

/** Put an earlier version back in use — saved again as the newest version. */
export async function restoreCopy(clientType: ClientTypeKey, version: number, by: string | null, baseVersion: number | null): Promise<SaveResult> {
  const old = await readVersion(clientType, version);
  if (!old) return { ok: false, reason: "invalid", errors: [`Version ${version} doesn't exist.`] };
  return saveCopy(clientType, old.sequence, by, `Restored version ${version}`, baseVersion);
}
