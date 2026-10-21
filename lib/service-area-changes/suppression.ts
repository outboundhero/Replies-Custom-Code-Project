/**
 * Per-client block list of leads taken out for a service-area change. Every
 * automation that puts a lead into a client's campaigns (nurture routing, the
 * Lead Mover, recover-stopped, the sequence-finished sync, manual pushes, the
 * DM4PM hand-off, the out-of-office re-send) checks it, so a removed lead can't
 * come back on its own. A lead comes off it only when someone lets it back in
 * from the change's page (its eligibility changed).
 *
 * Turso `client_lead_suppression`, one row per (client, email).
 */
import db from "@/lib/db";

let ready: Promise<void> | null = null;
export function ensureSuppressionTable(): Promise<void> {
  if (!ready) {
    ready = db.execute(`CREATE TABLE IF NOT EXISTS client_lead_suppression (
      client_tag TEXT NOT NULL,
      email TEXT NOT NULL,
      change_id INTEGER,
      reason TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT,
      lifted_at TEXT,
      lifted_by TEXT,
      PRIMARY KEY (client_tag, email)
    )`).then(() => undefined).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const norm = (e: string) => String(e || "").trim().toLowerCase();

// A short in-process cache: the routing paths call this once per client per run.
const cache = new Map<string, { at: number; set: Set<string> }>();
const CACHE_MS = 60_000;

/**
 * Emails blocked for this client. Throws if the list can't be read — callers
 * stop rather than risk re-adding a removed lead. `fresh` skips the cache (a
 * person's push must see a block made a moment ago in another process).
 */
export async function suppressedEmails(clientTag: string, opts: { fresh?: boolean } = {}): Promise<Set<string>> {
  const tag = String(clientTag || "").trim().toUpperCase();
  if (!tag) return new Set();
  const hit = cache.get(tag);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.set;
  await ensureSuppressionTable();
  const r = await db.execute({ sql: "SELECT email FROM client_lead_suppression WHERE client_tag = ? AND lifted_at IS NULL", args: [tag] });
  const set = new Set(r.rows.map((x) => norm(String(x.email))));
  cache.set(tag, { at: Date.now(), set });
  return set;
}

export async function isSuppressed(clientTag: string, email: string, opts: { fresh?: boolean } = {}): Promise<boolean> {
  return (await suppressedEmails(clientTag, opts)).has(norm(email));
}

/**
 * Block these emails for the client. A lead let back in is blocked again; one
 * already blocked keeps its block as it is (the change that made it owns it).
 */
export async function addSuppressions(clientTag: string, emails: string[], changeId: number, by: string | null, reason: string): Promise<number> {
  await ensureSuppressionTable();
  const tag = clientTag.toUpperCase();
  const list = [...new Set(emails.map(norm).filter(Boolean))];
  const now = new Date().toISOString();
  for (let i = 0; i < list.length; i += 100) {
    await db.batch(list.slice(i, i + 100).map((email) => ({
      sql: `INSERT INTO client_lead_suppression (client_tag, email, change_id, reason, created_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(client_tag, email) DO UPDATE SET change_id = excluded.change_id, reason = excluded.reason,
              created_at = excluded.created_at, created_by = excluded.created_by, lifted_at = NULL, lifted_by = NULL
            WHERE client_lead_suppression.lifted_at IS NOT NULL`,
      args: [tag, email, changeId, reason, now, by],
    })), "write");
  }
  cache.delete(tag);
  return list.length;
}

/**
 * Let these emails back in for the client. With `changeId`, only blocks that
 * change made (an automatic "kept" mustn't undo another change's removal); a
 * person letting a lead back in lifts it whatever made it.
 */
export async function liftSuppressions(clientTag: string, emails: string[], by: string | null, opts: { changeId?: number } = {}): Promise<number> {
  await ensureSuppressionTable();
  const tag = clientTag.toUpperCase();
  const list = [...new Set(emails.map(norm).filter(Boolean))];
  const now = new Date().toISOString();
  const own = opts.changeId != null ? " AND change_id = ?" : "";
  let n = 0;
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const r = await db.execute({
      sql: `UPDATE client_lead_suppression SET lifted_at = ?, lifted_by = ? WHERE client_tag = ? AND lifted_at IS NULL${own} AND email IN (${chunk.map(() => "?").join(",")})`,
      args: [now, by, tag, ...(opts.changeId != null ? [opts.changeId] : []), ...chunk],
    });
    n += r.rowsAffected ?? 0;
  }
  cache.delete(tag);
  return n;
}

/**
 * Blocked emails changed since a time (for the lead database's own check), one
 * page at a time in email order (`afterEmail` = the last email of the page before).
 */
export async function suppressionsSince(clientTag: string, sinceIso: string | null, afterEmail = "", limit = 5000): Promise<Array<{ email: string; blocked: boolean; changed_at: string; change_id: number | null }>> {
  await ensureSuppressionTable();
  const r = await db.execute({
    sql: `SELECT email, change_id, created_at, lifted_at FROM client_lead_suppression
          WHERE client_tag = ? AND email > ? AND (? IS NULL OR created_at > ? OR (lifted_at IS NOT NULL AND lifted_at > ?))
          ORDER BY email LIMIT ?`,
    args: [clientTag.toUpperCase(), afterEmail, sinceIso, sinceIso, sinceIso, limit],
  });
  return r.rows.map((x) => ({
    email: String(x.email),
    blocked: x.lifted_at == null,
    changed_at: String(x.lifted_at ?? x.created_at),
    change_id: x.change_id == null ? null : Number(x.change_id),
  }));
}
