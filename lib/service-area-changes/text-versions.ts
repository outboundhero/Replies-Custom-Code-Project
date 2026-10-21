/**
 * History of each client's service-area text on the Onboarding Form. The sync
 * overwrites the current copy every run, so without this nobody can see that
 * (or when) a client's area changed. The first text seen for a client is its
 * baseline; every later edit is kept, so the client page can say "the
 * Onboarding Form's service area changed on Oct 21" and show before / after.
 * Whitespace- and case-only edits don't count.
 */
import db from "@/lib/db";

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await db.execute(`CREATE TABLE IF NOT EXISTS service_area_text (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_tag TEXT NOT NULL,
        text TEXT NOT NULL,
        norm TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        baseline INTEGER NOT NULL DEFAULT 0
      )`);
      await db.execute("CREATE INDEX IF NOT EXISTS idx_sa_text_tag ON service_area_text(client_tag, id)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const normText = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

/** Record any client whose text differs from its last recorded version. Never throws (the sync must not fail on this). */
export async function recordServiceAreaTexts(rows: Array<{ tag: string; text: string | null | undefined }>): Promise<number> {
  try {
    await ensure();
    const latest = new Map<string, string>();
    const r = await db.execute(`SELECT t.client_tag, t.norm FROM service_area_text t
      JOIN (SELECT client_tag, MAX(id) AS id FROM service_area_text GROUP BY client_tag) m ON m.id = t.id`);
    for (const x of r.rows) latest.set(String(x.client_tag), String(x.norm));
    const now = new Date().toISOString();
    const inserts = [];
    for (const { tag, text } of rows) {
      const T = String(tag || "").trim().toUpperCase();
      const raw = String(text ?? "").trim();
      if (!T || !raw) continue; // an emptied cell isn't recorded as "everything removed"
      const n = normText(raw);
      if (latest.get(T) === n) continue;
      inserts.push({ sql: "INSERT INTO service_area_text (client_tag, text, norm, seen_at, baseline) VALUES (?, ?, ?, ?, ?)", args: [T, raw, n, now, latest.has(T) ? 0 : 1] });
      latest.set(T, n);
    }
    for (let i = 0; i < inserts.length; i += 50) await db.batch(inserts.slice(i, i + 50), "write");
    return inserts.length;
  } catch (e) {
    console.warn("[service-area-text] couldn't record:", (e as Error).message);
    return 0;
  }
}

/** The latest edit of a client's text (not its baseline), with the version before it. */
export async function latestTextChange(clientTag: string): Promise<{ changedAt: string; before: string; after: string } | null> {
  await ensure();
  const r = await db.execute({ sql: "SELECT text, seen_at, baseline FROM service_area_text WHERE client_tag = ? ORDER BY id DESC LIMIT 2", args: [clientTag.toUpperCase()] });
  if (r.rows.length < 2 || Number(r.rows[0].baseline) === 1) return null;
  return { changedAt: String(r.rows[0].seen_at), after: String(r.rows[0].text), before: String(r.rows[1].text) };
}
