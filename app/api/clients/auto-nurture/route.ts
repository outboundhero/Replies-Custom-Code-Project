/**
 * POST /api/clients/auto-nurture
 *
 * Enables or disables the per-client auto-nurture cron. Once enabled,
 * the /api/cron/nurture-auto-push job pushes that client's newly-
 * eligible Ready leads into the canonical 3 nurture campaigns every
 * 2 hours without operator input.
 *
 * Body: { clientTag: string, enabled: boolean }
 * Auth: admin (JWT session — same as other config mutations).
 */
import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { clientTag?: string; enabled?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const clientTag = (body.clientTag || "").trim().toUpperCase();
  const enabled = body.enabled === true;
  if (!clientTag) {
    return NextResponse.json({ error: "clientTag required" }, { status: 400 });
  }

  // Ensure a client_config row exists, then flip the flag. We use
  // INSERT OR IGNORE + UPDATE so we don't accidentally null out the
  // CC/BCC/template fields that may already be set on this row.
  await db.execute({
    sql: "INSERT OR IGNORE INTO client_config (client_tag) VALUES (?)",
    args: [clientTag],
  });
  // Opt-out model: the gate is auto_nurture_disabled. enabled=true clears it
  // (default ON); enabled=false sets it. We keep auto_nurture_enabled in sync
  // for the legacy badge/timestamp, but it is NOT the gate anymore.
  if (enabled) {
    await db.execute({
      sql: `UPDATE client_config
            SET auto_nurture_disabled = 0,
                auto_nurture_disabled_at = NULL,
                auto_nurture_enabled = 1,
                auto_nurture_enabled_at = COALESCE(auto_nurture_enabled_at, datetime('now')),
                updated_at = datetime('now')
            WHERE client_tag = ?`,
      args: [clientTag],
    });
  } else {
    await db.execute({
      sql: `UPDATE client_config
            SET auto_nurture_disabled = 1,
                auto_nurture_disabled_at = datetime('now'),
                auto_nurture_enabled = 0,
                updated_at = datetime('now')
            WHERE client_tag = ?`,
      args: [clientTag],
    });
  }

  return NextResponse.json({ ok: true, clientTag, enabled });
}
