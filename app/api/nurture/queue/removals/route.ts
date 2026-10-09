/** GET /api/nurture/queue/removals?tag=X — this client's recent queue removals (for the Undo list). */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import db from "@/lib/db";
import { ensureRemovalsTable, isUndoable } from "@/lib/nurture/queue-removals";

// Runs next to Turso (Mumbai): each read is one short hop, not a trip from the US.
export const preferredRegion = "bom1";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const tag = (req.nextUrl.searchParams.get("tag") || "").trim();
  if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });
  try {
    await ensureRemovalsTable();
    const r = await db.execute({
      sql: `SELECT id, removed_at, removed_by, mode, contacts, row_count, filters_json, restored_at, restored_by, status, ids_json IS NOT NULL AS has_ids
            FROM nurture_queue_removals WHERE UPPER(client_tag) = ? ORDER BY id DESC LIMIT 15`,
      args: [tag.toUpperCase()],
    });
    return NextResponse.json({
      removals: r.rows.map((x) => ({
        id: Number(x.id), removedAt: x.removed_at, removedBy: x.removed_by, mode: x.mode,
        contacts: Number(x.contacts) || 0, rows: Number(x.row_count) || 0, status: x.status ?? "done",
        filters: (() => { try { return x.filters_json ? JSON.parse(String(x.filters_json)) : null; } catch { return null; } })(),
        restoredAt: x.restored_at, restoredBy: x.restored_by,
        undoable: isUndoable({ status: x.status, ids_json: Number(x.has_ids) ? "1" : null, restored_at: x.restored_at, row_count: x.row_count }),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
