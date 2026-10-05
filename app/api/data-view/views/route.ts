import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import db from "@/lib/db";

/**
 * Personal saved views for the Data View — each user's own named filter /
 * grouping / sort presets. Private to the user (keyed by their login email) and
 * never change anyone's default: the Data View always opens on its built-in
 * default (Open Response for inbox managers) and a saved view only applies when
 * the user picks it.
 *
 *   GET                       → { views: [{ id, name, state, updated_at }] }
 *   POST   { name, state }    → create, or overwrite the user's view with that name
 *   PATCH  { id, state }      → update one of the user's views
 *   DELETE ?id=               → delete one of the user's views
 */

const MAX_NAME = 60;
const MAX_STATE_BYTES = 10_000;
const MAX_VIEWS = 50;

let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = db.execute(`CREATE TABLE IF NOT EXISTS data_view_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE (user_email, name)
    )`).then(() => undefined).catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

/** The signed-in internal user, or an error response. Client-scoped accounts
 *  don't have the Data View, so they don't get saved views either. */
async function currentUser(): Promise<{ email: string } | NextResponse> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.allowedClientTags && session.allowedClientTags.length) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return { email: session.email.trim().toLowerCase() };
}

function cleanState(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const json = JSON.stringify(raw);
  return json.length <= MAX_STATE_BYTES ? json : null;
}

function rowToView(r: Record<string, unknown>) {
  let state: unknown = {};
  try { state = JSON.parse(String(r.state)); } catch { /* corrupt row → empty state */ }
  return { id: Number(r.id), name: String(r.name), state, updated_at: String(r.updated_at ?? "") };
}

export async function GET() {
  const user = await currentUser();
  if (user instanceof NextResponse) return user;
  await ensureTable();
  const r = await db.execute({
    sql: "SELECT id, name, state, updated_at FROM data_view_views WHERE user_email = ? ORDER BY name COLLATE NOCASE",
    args: [user.email],
  });
  return NextResponse.json({ views: r.rows.map((x) => rowToView(x as unknown as Record<string, unknown>)) });
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => ({}));
  const name = String(body?.name ?? "").trim().replace(/\s+/g, " ");
  if (!name) return NextResponse.json({ error: "Give the view a name." }, { status: 400 });
  if (name.length > MAX_NAME) return NextResponse.json({ error: `Keep the name under ${MAX_NAME} characters.` }, { status: 400 });
  const state = cleanState(body?.state);
  if (!state) return NextResponse.json({ error: "Invalid view." }, { status: 400 });
  await ensureTable();

  // Same name (any case) → overwrite that view instead of creating a twin.
  const existing = await db.execute({
    sql: "SELECT id FROM data_view_views WHERE user_email = ? AND name = ? COLLATE NOCASE",
    args: [user.email, name],
  });
  if (existing.rows[0]) {
    const id = Number(existing.rows[0].id);
    await db.execute({
      sql: "UPDATE data_view_views SET name = ?, state = ?, updated_at = datetime('now') WHERE id = ? AND user_email = ?",
      args: [name, state, id, user.email],
    });
  } else {
    const count = await db.execute({ sql: "SELECT COUNT(*) AS n FROM data_view_views WHERE user_email = ?", args: [user.email] });
    if (Number(count.rows[0]?.n ?? 0) >= MAX_VIEWS) {
      return NextResponse.json({ error: `You can keep up to ${MAX_VIEWS} saved views — delete one first.` }, { status: 400 });
    }
    await db.execute({
      sql: "INSERT INTO data_view_views (user_email, name, state) VALUES (?, ?, ?)",
      args: [user.email, name, state],
    });
  }
  const saved = await db.execute({
    sql: "SELECT id, name, state, updated_at FROM data_view_views WHERE user_email = ? AND name = ? COLLATE NOCASE",
    args: [user.email, name],
  });
  return NextResponse.json({ ok: true, view: rowToView(saved.rows[0] as unknown as Record<string, unknown>), replaced: !!existing.rows[0] });
}

export async function PATCH(req: NextRequest) {
  const user = await currentUser();
  if (user instanceof NextResponse) return user;
  const body = await req.json().catch(() => ({}));
  const id = Number(body?.id);
  const state = cleanState(body?.state);
  if (!id || !state) return NextResponse.json({ error: "Invalid view." }, { status: 400 });
  await ensureTable();
  const r = await db.execute({
    sql: "UPDATE data_view_views SET state = ?, updated_at = datetime('now') WHERE id = ? AND user_email = ?",
    args: [state, id, user.email],
  });
  if (!r.rowsAffected) return NextResponse.json({ error: "View not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const user = await currentUser();
  if (user instanceof NextResponse) return user;
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "Invalid view." }, { status: 400 });
  await ensureTable();
  const r = await db.execute({ sql: "DELETE FROM data_view_views WHERE id = ? AND user_email = ?", args: [id, user.email] });
  if (!r.rowsAffected) return NextResponse.json({ error: "View not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
