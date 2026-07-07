/**
 * GET /api/leads/move/skipped?runId=…&clientTag=…&limit=…
 *
 * Lists leads the Lead Mover skipped by the service-area gate, for the on-page
 * viewer. Omits the big `custom_variables` blob (that's only in the CSV export).
 * Also returns the total count for the current filter.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import db from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const runId = req.nextUrl.searchParams.get("runId");
  const clientTag = req.nextUrl.searchParams.get("clientTag");
  const limit = Math.min(1000, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 200));

  const conditions: string[] = [];
  const args: (string | number)[] = [];
  if (runId) { conditions.push("run_id = ?"); args.push(runId); }
  if (clientTag) { conditions.push("client_tag = ?"); args.push(clientTag.toUpperCase()); }
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";

  try {
    const countRes = await db.execute({ sql: `SELECT COUNT(*) AS n FROM lead_move_skipped${where}`, args });
    const total = Number(countRes.rows[0]?.n) || 0;
    const listRes = await db.execute({
      sql: `SELECT client_tag, email, first_name, last_name, company, city, state, reason,
              source_campaign_name, source_instance, target_instance, ob_lead_id, skipped_at
            FROM lead_move_skipped${where} ORDER BY skipped_at DESC LIMIT ?`,
      args: [...args, limit],
    });
    return NextResponse.json({ total, rows: listRes.rows });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
