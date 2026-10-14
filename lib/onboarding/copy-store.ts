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
import { CLIENT_TYPES, checkSequence, cleanSequence, clientTypeLabel, normClientTag, type ClientTypeKey, type CopySequence } from "@/lib/onboarding/copy-model";
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

// ── One client's own copy ───────────────────────────────────────────────────
//
// A client can have its own version of the emails instead of its type's
// shared copy (e.g. extra lines a Canadian client needs). Same rules as the
// shared copy: every save is a new version, nothing is overwritten, and a save
// says which version it was editing. A version can also say "use the shared
// copy again" (mode "shared", no emails), which is how a client goes back.
//
// A client's copy never follows later edits to the shared copy by itself —
// `basedOn` records the shared version it was last checked against, so the
// page can say when the shared copy has moved on.

export type ClientCopyMode = "custom" | "shared";
export interface ClientCopyVersion {
  id: string;
  clientTag: string;
  version: number;
  mode: ClientCopyMode;
  /** The client type whose shared copy this one was made from. */
  clientType: ClientTypeKey;
  /** The shared copy's version this one was made from or last checked against. */
  basedOn: number | null;
  sequence: CopySequence | null;
  savedBy: string | null;
  savedAt: string;
  note: string | null;
}
export type ClientCopyMeta = Omit<ClientCopyVersion, "sequence">;
export type ClientSaveResult =
  | { ok: true; version: ClientCopyVersion }
  | { ok: false; reason: "invalid"; errors: string[] }
  | { ok: false; reason: "conflict"; current: number | null; message: string };


let clientReady: Promise<void> | null = null;
function ensureClient(): Promise<void> {
  clientReady ??= (async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS onboarding_client_copy (
      id TEXT PRIMARY KEY,
      client_tag TEXT NOT NULL,
      version INTEGER NOT NULL,
      mode TEXT NOT NULL,
      client_type TEXT NOT NULL,
      based_on INTEGER,
      steps TEXT,
      saved_by TEXT,
      saved_at TEXT NOT NULL,
      note TEXT
    )`);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_client_copy_version ON onboarding_client_copy(client_tag, version)`);
  })().catch((e) => { clientReady = null; throw e; });
  return clientReady;
}

const CLIENT_COLS = "id, client_tag, version, mode, client_type, based_on, steps, saved_by, saved_at, note";
const rowToClient = (r: Record<string, unknown>): ClientCopyVersion => {
  const mode: ClientCopyMode = r.mode === "shared" ? "shared" : "custom";
  return {
    id: String(r.id),
    clientTag: String(r.client_tag),
    version: Number(r.version),
    mode,
    clientType: (CLIENT_TYPES.some((t) => t.key === r.client_type) ? r.client_type : "cleaning") as ClientTypeKey,
    basedOn: r.based_on == null ? null : Number(r.based_on),
    sequence: mode === "custom" && r.steps ? cleanSequence(JSON.parse(String(r.steps))) ?? { steps: [] } : null,
    savedBy: (r.saved_by as string | null) ?? null,
    savedAt: String(r.saved_at),
    note: (r.note as string | null) ?? null,
  };
};
const toMeta = ({ sequence: _s, ...m }: ClientCopyVersion): ClientCopyMeta => { void _s; return m; };

/** Every client that has (or had) its own copy: its newest version with the emails, and its version list. */
export async function readClientCopies(onlyTag?: string): Promise<{ tag: string; latest: ClientCopyVersion; versions: ClientCopyMeta[] }[]> {
  await ensureClient();
  const where = onlyTag ? "WHERE client_tag = ?" : "";
  const args = onlyTag ? [onlyTag] : [];
  const [list, latest] = await Promise.all([
    db.execute({ sql: `SELECT id, client_tag, version, mode, client_type, based_on, NULL AS steps, saved_by, saved_at, note FROM onboarding_client_copy ${where} ORDER BY client_tag, version DESC`, args }),
    db.execute({
      sql: `SELECT ${CLIENT_COLS.split(", ").map((c) => `c.${c}`).join(", ")} FROM onboarding_client_copy c
            JOIN (SELECT client_tag, MAX(version) AS v FROM onboarding_client_copy ${where} GROUP BY client_tag) m
              ON m.client_tag = c.client_tag AND m.v = c.version`,
      args,
    }),
  ]);
  const metas = list.rows.map((r) => toMeta(rowToClient(r as Record<string, unknown>)));
  return latest.rows
    .map((r) => rowToClient(r as Record<string, unknown>))
    .sort((a, b) => a.clientTag.localeCompare(b.clientTag))
    .map((l) => ({ tag: l.clientTag, latest: l, versions: metas.filter((m) => m.clientTag === l.clientTag) }));
}

export async function readClientVersion(tag: string, version: number): Promise<ClientCopyVersion | null> {
  await ensureClient();
  const r = await db.execute({ sql: `SELECT ${CLIENT_COLS} FROM onboarding_client_copy WHERE client_tag = ? AND version = ?`, args: [tag, version] });
  return r.rows[0] ? rowToClient(r.rows[0] as Record<string, unknown>) : null;
}

async function latestClient(tag: string): Promise<ClientCopyVersion | null> {
  await ensureClient();
  const r = await db.execute({ sql: `SELECT ${CLIENT_COLS} FROM onboarding_client_copy WHERE client_tag = ? ORDER BY version DESC LIMIT 1`, args: [tag] });
  return r.rows[0] ? rowToClient(r.rows[0] as Record<string, unknown>) : null;
}

/** Add a version for `tag`, refused when the newest isn't `baseVersion` (someone saved meanwhile). */
async function addClientVersion(tag: string, baseVersion: number | null, row: Omit<ClientCopyVersion, "id" | "clientTag" | "version" | "savedAt">): Promise<ClientSaveResult> {
  const latest = await latestClient(tag);
  const latestVersion = latest?.version ?? null;
  if (latestVersion !== baseVersion) {
    return { ok: false, reason: "conflict", current: latestVersion, message: `${tag}'s copy was saved by ${latest?.savedBy ?? "someone"} while you were editing (now version ${latestVersion}).` };
  }
  const next = (latestVersion ?? 0) + 1;
  const v: ClientCopyVersion = { id: randomUUID(), clientTag: tag, version: next, savedAt: new Date().toISOString(), ...row, note: row.note?.trim() ? row.note.trim().slice(0, 500) : null };
  try {
    await db.execute({
      sql: `INSERT INTO onboarding_client_copy (${CLIENT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [v.id, tag, next, v.mode, v.clientType, v.basedOn, v.sequence ? JSON.stringify(v.sequence) : null, v.savedBy, v.savedAt, v.note],
    });
  } catch (e) {
    if (/unique|constraint/i.test((e as Error).message)) return { ok: false, reason: "conflict", current: next, message: `Someone saved ${tag}'s copy at the same moment.` };
    throw e;
  }
  return { ok: true, version: v };
}

/** Save the client's own emails as a new version. */
export async function saveClientCopy(tag: string, clientType: ClientTypeKey, sequence: CopySequence, by: string | null, note: string | null, baseVersion: number | null, basedOn: number | null): Promise<ClientSaveResult> {
  const check = checkSequence(sequence);
  if (check.errors.length) return { ok: false, reason: "invalid", errors: check.errors.map((e) => `Email ${e.step}: ${e.message}`) };
  return addClientVersion(tag, baseVersion, { mode: "custom", clientType, basedOn, sequence, savedBy: by, note });
}

/** The client goes back to a type's shared copy (its own versions stay in the history). */
export async function switchToSharedCopy(tag: string, by: string | null, baseVersion: number | null, note?: string, clientType?: ClientTypeKey): Promise<ClientSaveResult> {
  const latest = await latestClient(tag);
  if (!latest || latest.mode !== "custom") return { ok: false, reason: "invalid", errors: [`${tag} already uses the shared copy.`] };
  const type = clientType ?? latest.clientType;
  return addClientVersion(tag, baseVersion, { mode: "shared", clientType: type, basedOn: latest.basedOn, sequence: null, savedBy: by, note: note ?? `Back to the shared ${clientTypeLabel(type)} copy` });
}

/**
 * A client leaving onboarding goes back to the shared copy, so the copy can't
 * quietly come back if the same tag is added again later. History is kept.
 */
export async function retireClientCopy(tag: string, by: string | null): Promise<void> {
  const t = normClientTag(tag);
  if (!t) return;
  const latest = await latestClient(t);
  if (latest?.mode !== "custom") return;
  await switchToSharedCopy(t, by, latest.version, "Removed from onboarding — back on the shared copy");
}

/** Someone compared this client's copy with the shared copy as it is now — record it, emails unchanged. */
export async function markClientCopyChecked(tag: string, by: string | null, baseVersion: number | null): Promise<ClientSaveResult> {
  const latest = await latestClient(tag);
  if (!latest || latest.mode !== "custom" || !latest.sequence) return { ok: false, reason: "invalid", errors: [`${tag} doesn't have its own copy.`] };
  const shared = await currentCopy(latest.clientType);
  if (!shared) return { ok: false, reason: "invalid", errors: [`There is no shared ${clientTypeLabel(latest.clientType)} copy to check against.`] };
  if (latest.basedOn === shared.version) return { ok: false, reason: "invalid", errors: [`Already checked against version ${shared.version} of the shared copy.`] };
  return addClientVersion(tag, baseVersion, {
    mode: "custom", clientType: latest.clientType, basedOn: shared.version, sequence: latest.sequence, savedBy: by,
    note: `Checked against the shared ${clientTypeLabel(latest.clientType)} copy, version ${shared.version}`,
  });
}

/** Put an earlier version back — saved again as the newest. */
export async function restoreClientCopy(tag: string, version: number, by: string | null, baseVersion: number | null): Promise<ClientSaveResult> {
  const old = await readClientVersion(tag, version);
  if (!old) return { ok: false, reason: "invalid", errors: [`Version ${version} doesn't exist.`] };
  if (old.mode === "shared") return switchToSharedCopy(tag, by, baseVersion, `Restored version ${version} (the shared copy)`, old.clientType);
  return addClientVersion(tag, baseVersion, { mode: "custom", clientType: old.clientType, basedOn: old.basedOn, sequence: old.sequence, savedBy: by, note: `Restored version ${version}` });
}

/**
 * The emails a client's campaigns are built from: its own copy when it has
 * one, otherwise its type's shared copy (null when neither exists yet).
 */
export async function copyForClient(tag: string, clientType: ClientTypeKey): Promise<{ source: "client" | "shared"; version: number; sequence: CopySequence } | null> {
  const t = normClientTag(tag);
  const own = t ? await latestClient(t) : null;
  if (own?.mode === "custom" && own.sequence) return { source: "client", version: own.version, sequence: own.sequence };
  const shared = await currentCopy(clientType);
  return shared ? { source: "shared", version: shared.version, sequence: shared.sequence } : null;
}
