/**
 * POST /api/nurture/sync
 * Runs the sequence-finished sync from EmailBison/OutboundHero.
 * Restricted to admins.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { syncSequenceFinished } from "@/lib/nurture/sync-sequence-finished";

export async function POST() {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const result = await syncSequenceFinished();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[api/nurture/sync] POST failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
