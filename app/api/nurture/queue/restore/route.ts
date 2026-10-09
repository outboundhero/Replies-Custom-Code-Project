/**
 * POST /api/nurture/queue/restore { removalId } — Undo one queue removal:
 * clears the skip flag on exactly the rows that removal flagged (rows added to
 * a campaign since are left alone). One-shot. A removal without an exact row
 * list (made before the database patch) is refused rather than guessed by
 * email — that could un-skip rows something else had skipped.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";
import db from "@/lib/db";
import { markTagStatsDirty } from "@/lib/nurture/overview";
import { ensureRemovalsTable, dropFirstPageCache } from "@/lib/nurture/queue-removals";
import { logActivity } from "@/lib/errors";

// Runs next to Supabase (Singapore), where the queue queries execute; Turso (Mumbai) is one short hop.
export const preferredRegion = "sin1";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const removalId = Number(body?.removalId);
  if (!Number.isInteger(removalId) || removalId <= 0) return NextResponse.json({ error: "removalId required" }, { status: 400 });
  try {
    await ensureRemovalsTable();
    const session = await getSession();
    // Claim it first (one-shot) so a double-click can't run it twice.
    const claim = await db.execute({
      sql: `UPDATE nurture_queue_removals SET restored_at = ?, restored_by = ?
            WHERE id = ? AND restored_at IS NULL AND ids_json IS NOT NULL AND (status IS NULL OR status = 'done')
            RETURNING client_tag, ids_json, contacts`,
      args: [new Date().toISOString(), session?.email ?? null, removalId],
    });
    const rec = claim.rows[0];
    if (!rec) {
      const r = await db.execute({ sql: "SELECT restored_at, ids_json, status FROM nurture_queue_removals WHERE id = ?", args: [removalId] });
      const x = r.rows[0];
      const why = !x ? "Removal not found."
        : x.restored_at ? "Already undone."
        : !x.ids_json ? "This removal can't be undone automatically (it was made before the database update)."
        : `This removal ${x.status === "failed" ? "failed, so there's nothing to undo" : "isn't finished"}.`;
      return NextResponse.json({ error: why }, { status: 409 });
    }
    const tag = String(rec.client_tag);

    let restored = 0;
    try {
      const ids = JSON.parse(String(rec.ids_json)) as { reply: number[]; seq: number[]; legacy: number[] };
      const { data, error } = await supabase.rpc("nurture_queue_restore_rows", {
        p_tag: tag, p_reply_ids: ids.reply ?? [], p_seq_ids: ids.seq ?? [], p_legacy_ids: ids.legacy ?? [],
      });
      if (error) throw new Error(error.message);
      restored = Number(data?.rows ?? 0);
    } catch (e) {
      // Release the claim so it can be retried.
      await db.execute({ sql: "UPDATE nurture_queue_removals SET restored_at = NULL, restored_by = NULL WHERE id = ?", args: [removalId] });
      throw e;
    }

    await db.execute({ sql: "UPDATE nurture_queue_removals SET restored_rows = ? WHERE id = ?", args: [restored, removalId] });
    if (restored > 0) { await markTagStatsDirty(tag); await dropFirstPageCache(tag); }
    await logActivity("nurture", "queue-restore", { client_tag: tag, details: { by: session?.email, removal_id: removalId, rows: restored } });
    return NextResponse.json({ ok: true, rows: restored, contacts: Number(rec.contacts) || 0 });
  } catch (e) {
    console.error("[api/nurture/queue/restore]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
