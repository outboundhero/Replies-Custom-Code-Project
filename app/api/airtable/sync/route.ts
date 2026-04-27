/**
 * POST /api/airtable/sync
 *
 * Admin-only endpoint to backfill an Airtable table into nurture_legacy_leads
 * on demand. Wraps the same backfillTable function the CLI script uses.
 *
 * Body: { baseId?: string, tableId?: string }
 *   Defaults to baseId = appqZiSdsbeBCuHEp, tableId = tbl1BnpnsUBrBGeuy
 *   (Master Inbox in Section 1).
 *
 * Returns: { ok, baseId, tableId, ...counts }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  backfillTable,
  DEFAULT_BASE_ID,
  DEFAULT_TABLE_ID,
} from "@/lib/airtable/backfill-nurture";

export const maxDuration = 300; // backfill of a large table can take a while

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({}));
    const baseId: string = body.baseId || DEFAULT_BASE_ID;
    const tableId: string = body.tableId || DEFAULT_TABLE_ID;

    const result = await backfillTable(baseId, tableId);

    return NextResponse.json({
      ok: result.errors === 0,
      ...result,
    });
  } catch (error) {
    console.error("[api/airtable/sync] POST failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
