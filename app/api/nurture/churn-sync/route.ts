/**
 * POST /api/nurture/churn-sync
 *
 * Admin-triggered refresh of the churned-clients set from the Client Tracker
 * sheet (Status="Churned" AND Churn Date on/before today). Same logic as the
 * cron, callable from the Automation tab's "Sync churned" button.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { rebuildChurnedClients } from "@/lib/churn";

export const maxDuration = 60;

export async function POST() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const { count, tags } = await rebuildChurnedClients();
    return NextResponse.json({ ok: true, churned: count, tags });
  } catch (e) {
    return NextResponse.json({ error: `sheet read failed: ${(e as Error).message}` }, { status: 500 });
  }
}
