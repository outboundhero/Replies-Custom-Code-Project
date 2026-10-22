/**
 * History of each client's service-area text on the Onboarding Form, and the
 * alerts it raises. The sheet sync (every 6 hours) overwrites the current copy,
 * so every edit is kept here: the first text seen for a client is its baseline,
 * and each later edit is compared with the one before it, place by place
 * (lib/service-area-changes/area-text.ts). When places were added or taken
 * out, an alert says which — on the All Clients page, the client's page, the
 * sidebar, and Slack when SLACK_SERVICE_AREA_CHANNEL is set. A client has at
 * most one open alert: later edits fold into it (an edit that puts everything
 * back closes it). Whitespace- and case-only edits don't count.
 */
import db from "@/lib/db";
import { diffAreaText, type AreaItem } from "@/lib/service-area-changes/area-text";
import { postToChannel } from "@/lib/slack";
import { bumpVersion } from "@/lib/server-cache";

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
      // alert_pending = 1: a new version whose alert hasn't been worked out yet (retried next sync).
      try { await db.execute("ALTER TABLE service_area_text ADD COLUMN alert_pending INTEGER NOT NULL DEFAULT 0"); } catch { /* already there */ }
      // status: open → dismissed (looked at, nothing to do) | recorded (a removal was started from it) | reverted (the edit was undone)
      await db.execute(`CREATE TABLE IF NOT EXISTS service_area_alert (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_tag TEXT NOT NULL,
        from_version INTEGER NOT NULL,
        to_version INTEGER NOT NULL,
        removed_json TEXT NOT NULL,
        added_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        detected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        handled_by TEXT, handled_at TEXT, change_id INTEGER,
        slack_error TEXT
      )`);
      await db.execute("CREATE INDEX IF NOT EXISTS idx_sa_alert_open ON service_area_alert(status, client_tag)");
      // One open alert per client, even if two syncs run at once.
      await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_sa_alert_one_open ON service_area_alert(client_tag) WHERE status = 'open'");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const normText = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
const nowIso = () => new Date().toISOString();

export interface ServiceAreaAlert {
  id: number; clientTag: string; detectedAt: string; updatedAt: string;
  /** The version it was last worked out on — closing it names this, so newer removals aren't closed unseen. */
  toVersion: number;
  removed: AreaItem[]; added: AreaItem[];
  before: string; after: string;
  status: "open" | "dismissed" | "recorded" | "reverted";
  handledBy: string | null; handledAt: string | null; changeId: number | null;
}

/**
 * Record any client whose text differs from its last recorded version, and raise
 * (or update) its alert when places changed. Never throws — the sync must not
 * fail on this.
 */
export async function recordServiceAreaTexts(rows: Array<{ tag: string; text: string | null | undefined }>): Promise<number> {
  try {
    await ensure();
    const latest = new Map<string, { id: number; norm: string; text: string }>();
    const r = await db.execute(`SELECT t.id, t.client_tag, t.norm, t.text FROM service_area_text t
      JOIN (SELECT client_tag, MAX(id) AS id FROM service_area_text GROUP BY client_tag) m ON m.id = t.id`);
    for (const x of r.rows) latest.set(String(x.client_tag), { id: Number(x.id), norm: String(x.norm), text: String(x.text) });
    const now = nowIso();
    const todo: Array<{ tag: string; text: string; norm: string; prev: number | null }> = [];
    const seen = new Set<string>();
    for (const { tag, text } of rows) {
      const T = String(tag || "").trim().toUpperCase();
      const raw = String(text ?? "").trim();
      if (!T || !raw || seen.has(T)) continue; // an emptied cell isn't recorded as "everything removed"
      seen.add(T);
      const norm = normText(raw);
      const prev = latest.get(T);
      if (prev?.norm === norm) continue;
      todo.push({ tag: T, text: raw, norm, prev: prev?.id ?? null });
    }
    for (let i = 0; i < todo.length; i += 50) {
      const chunk = todo.slice(i, i + 50);
      await db.batch(chunk.map((t) => ({
        sql: "INSERT INTO service_area_text (client_tag, text, norm, seen_at, baseline, alert_pending) VALUES (?, ?, ?, ?, ?, ?)",
        args: [t.tag, t.text, t.norm, now, t.prev == null ? 1 : 0, t.prev == null ? 0 : 1], // a baseline raises nothing
      })), "write");
    }
    // Work out the alert of every new version — and of any a failed run left behind.
    const pending = await db.execute("SELECT id, client_tag, text FROM service_area_text WHERE alert_pending = 1 ORDER BY id");
    for (const v of pending.rows) {
      const tag = String(v.client_tag), id = Number(v.id);
      try {
        const prev = Number((await db.execute({ sql: "SELECT MAX(id) AS id FROM service_area_text WHERE client_tag = ? AND id < ?", args: [tag, id] })).rows[0]?.id) || 0;
        if (prev) await raiseAlert(tag, prev, id, String(v.text));
        await db.execute({ sql: "UPDATE service_area_text SET alert_pending = 0 WHERE id = ?", args: [id] });
      } catch (e) {
        console.warn("[service-area-text] alert for", tag, "failed (tried again next sync):", (e as Error).message);
      }
    }
    return todo.length;
  } catch (e) {
    console.warn("[service-area-text] couldn't record:", (e as Error).message);
    return 0;
  }
}

/** Open (or update) the client's alert for a new version; close it when the places are back as they were. */
async function raiseAlert(tag: string, prevVersion: number, newVersion: number, newText: string): Promise<void> {
  let open = (await db.execute({ sql: "SELECT id, from_version, to_version, removed_json, added_json FROM service_area_alert WHERE client_tag = ? AND status = 'open' ORDER BY id DESC LIMIT 1", args: [tag] })).rows[0];
  if (open && Number(open.to_version) >= newVersion) return; // already worked out (a retry)
  const fromVersion = open ? Number(open.from_version) : prevVersion;
  const fromText = String((await db.execute({ sql: "SELECT text FROM service_area_text WHERE id = ?", args: [fromVersion] })).rows[0]?.text ?? "");
  const d = diffAreaText(fromText, newText);
  const empty = !d.removed.length && !d.added.length;
  const now = nowIso();
  let alertId: number;
  if (!open && !empty) {
    const ins = await db.execute({
      sql: `INSERT INTO service_area_alert (client_tag, from_version, to_version, removed_json, added_json, status, detected_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'open', ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
      args: [tag, fromVersion, newVersion, JSON.stringify(d.removed), JSON.stringify(d.added), now, now],
    });
    if (ins.rows.length) { await notifySlack(Number(ins.rows[0].id), tag, d.removed, d.added, false); return; }
    // Another run opened one meanwhile: fold into it.
    open = (await db.execute({ sql: "SELECT id, from_version, to_version, removed_json, added_json FROM service_area_alert WHERE client_tag = ? AND status = 'open' LIMIT 1", args: [tag] })).rows[0];
    if (!open) return;
  }
  if (open) {
    alertId = Number(open.id);
    const same = String(open.removed_json) === JSON.stringify(d.removed) && String(open.added_json) === JSON.stringify(d.added);
    await db.execute({
      sql: `UPDATE service_area_alert SET to_version = ?, removed_json = ?, added_json = ?, updated_at = ?,
              status = CASE WHEN ? THEN 'reverted' ELSE status END, handled_at = CASE WHEN ? THEN ? ELSE handled_at END
            WHERE id = ? AND status = 'open'`,
      args: [newVersion, JSON.stringify(d.removed), JSON.stringify(d.added), now, empty ? 1 : 0, empty ? 1 : 0, now, alertId],
    });
    if (empty || same) return; // closed, or only re-worded — nothing new to tell
    await notifySlack(alertId, tag, d.removed, d.added, true);
  }
}

// Slack's control characters (the text comes from the sheet).
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const listLabels = (xs: AreaItem[], max = 12) =>
  esc(`${xs.slice(0, max).map((x) => (x.kind === "zip" ? `ZIP ${x.label}` : x.kind === "state" ? `${x.label} (state)` : x.label)).join(" · ")}${xs.length > max ? ` · +${xs.length - max} more` : ""}`);

/** A Slack post for the alert, when a channel is set (SLACK_SERVICE_AREA_CHANNEL). Never throws. */
async function notifySlack(alertId: number, tag: string, removed: AreaItem[], added: AreaItem[], updated: boolean): Promise<void> {
  const channel = process.env.SLACK_SERVICE_AREA_CHANNEL?.trim();
  if (!channel || !process.env.SLACK_BOT_TOKEN) return;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const link = host ? `\n<https://${host}/clients/${encodeURIComponent(tag)}|Open ${tag}'s page>` : "";
  const text = [
    `*${tag}: service area ${updated ? "changed again" : "changed"} on the Onboarding Form*`,
    removed.length ? `Removed (${removed.length}): ${listLabels(removed)}` : "",
    added.length ? `Added (${added.length}): ${listLabels(added)}` : "",
    removed.length ? "If the client stopped serving these places, record them under Service area changes." : "",
  ].filter(Boolean).join("\n") + link;
  try {
    // Never hold up the sheet sync on Slack.
    const r = await Promise.race([
      postToChannel(channel, text),
      new Promise<{ ok: false; error: string }>((res) => setTimeout(() => res({ ok: false, error: "Slack didn't answer in 5s" }), 5000)),
    ]);
    await db.execute({ sql: "UPDATE service_area_alert SET slack_error = ? WHERE id = ?", args: [r.ok ? null : String(r.error).slice(0, 200), alertId] });
  } catch (e) {
    await db.execute({ sql: "UPDATE service_area_alert SET slack_error = ? WHERE id = ?", args: [(e as Error).message.slice(0, 200), alertId] }).catch(() => {});
  }
}

async function toAlert(x: Record<string, unknown>, withText = true): Promise<ServiceAreaAlert> {
  const v = withText ? await db.execute({ sql: "SELECT id, text FROM service_area_text WHERE id IN (?, ?)", args: [Number(x.from_version), Number(x.to_version)] }) : { rows: [] as Record<string, unknown>[] };
  const text = (id: unknown) => String(v.rows.find((r) => Number(r.id) === Number(id))?.text ?? "");
  return {
    id: Number(x.id), clientTag: String(x.client_tag), detectedAt: String(x.detected_at), updatedAt: String(x.updated_at), toVersion: Number(x.to_version),
    removed: JSON.parse(String(x.removed_json || "[]")), added: JSON.parse(String(x.added_json || "[]")),
    before: text(x.from_version), after: text(x.to_version),
    status: String(x.status) as ServiceAreaAlert["status"],
    handledBy: (x.handled_by as string) ?? null, handledAt: (x.handled_at as string) ?? null, changeId: x.change_id == null ? null : Number(x.change_id),
  };
}

/** Every open alert, newest first (All Clients page) — the lists only, not the texts. */
export async function openAlerts(): Promise<ServiceAreaAlert[]> {
  await ensure();
  const r = await db.execute("SELECT * FROM service_area_alert WHERE status = 'open' ORDER BY updated_at DESC LIMIT 200");
  return Promise.all(r.rows.map((x) => toAlert(x as Record<string, unknown>, false)));
}

export async function openAlertCount(): Promise<number> {
  await ensure();
  return Number((await db.execute("SELECT COUNT(*) AS n FROM service_area_alert WHERE status = 'open'")).rows[0]?.n) || 0;
}

/** The client's open alert, else its latest handled one from the last 30 days (shown greyed). */
export async function clientAlert(clientTag: string): Promise<ServiceAreaAlert | null> {
  await ensure();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const r = await db.execute({
    sql: `SELECT * FROM service_area_alert WHERE client_tag = ? AND (status = 'open' OR (status IN ('dismissed', 'recorded') AND updated_at > ?))
          ORDER BY status = 'open' DESC, id DESC LIMIT 1`,
    args: [clientTag.toUpperCase(), since],
  });
  return r.rows.length ? toAlert(r.rows[0] as Record<string, unknown>) : null;
}

/**
 * Close an open alert: looked at and nothing to do, or a removal was started
 * from it — only as it was seen (`toVersion`): one a newer edit changed since
 * stays open, so places nobody saw aren't closed with it.
 */
export async function handleAlert(id: number, clientTag: string, toVersion: number, status: "dismissed" | "recorded", by: string | null, changeId: number | null = null): Promise<boolean> {
  await ensure();
  const r = await db.execute({
    sql: "UPDATE service_area_alert SET status = ?, handled_by = ?, handled_at = ?, change_id = ?, updated_at = ? WHERE id = ? AND client_tag = ? AND to_version = ? AND status = 'open'",
    args: [status, by, nowIso(), changeId, nowIso(), id, clientTag.toUpperCase(), toVersion],
  });
  if ((r.rowsAffected ?? 0) > 0) { bumpVersion(ALERT_NS); return true; }
  return false;
}

/** Cache namespace of the alert count (bumped when an alert is closed here). */
export const ALERT_NS = "service-area-alerts";
