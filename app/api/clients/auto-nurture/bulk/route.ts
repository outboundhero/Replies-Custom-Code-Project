/**
 * POST /api/clients/auto-nurture/bulk
 *
 * Bulk enable/disable auto-nurture for many clients at once — by Section
 * (all that section's tags) and/or an explicit list of client tags.
 * Opt-out model: enabled=true clears auto_nurture_disabled; false sets it.
 *
 * Body: { enabled: boolean, clientTags?: string[], sectionIds?: number[] }
 * Auth: admin (JWT session).
 */
import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { enabled?: boolean; clientTags?: string[]; sectionIds?: number[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const enabled = body.enabled === true;
  const tags = new Set<string>();
  for (const t of body.clientTags || []) {
    const tag = (t || "").trim().toUpperCase();
    if (tag) tags.add(tag);
  }
  if (Array.isArray(body.sectionIds) && body.sectionIds.length > 0) {
    const placeholders = body.sectionIds.map(() => "?").join(",");
    const res = await db.execute({
      sql: `SELECT tag FROM client_tags WHERE section_id IN (${placeholders})`,
      args: body.sectionIds.map((n) => Number(n)),
    });
    for (const r of res.rows) {
      const tag = String(r.tag || "").trim().toUpperCase();
      if (tag) tags.add(tag);
    }
  }

  const list = [...tags];
  if (list.length === 0) return NextResponse.json({ error: "No clientTags or sectionIds resolved" }, { status: 400 });

  const setSql = enabled
    ? "auto_nurture_disabled = 0, auto_nurture_disabled_at = NULL, auto_nurture_enabled = 1, auto_nurture_enabled_at = COALESCE(auto_nurture_enabled_at, datetime('now')), updated_at = datetime('now')"
    : "auto_nurture_disabled = 1, auto_nurture_disabled_at = datetime('now'), auto_nurture_enabled = 0, updated_at = datetime('now')";

  // Ensure rows exist, then flip — batched in chunks of 100.
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    await db.batch(
      chunk.flatMap((tag) => [
        { sql: "INSERT OR IGNORE INTO client_config (client_tag) VALUES (?)", args: [tag] },
        { sql: `UPDATE client_config SET ${setSql} WHERE client_tag = ?`, args: [tag] },
      ]),
      "write",
    );
  }

  return NextResponse.json({ ok: true, updated: list.length, enabled });
}
