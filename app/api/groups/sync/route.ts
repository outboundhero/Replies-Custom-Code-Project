/**
 * POST /api/groups/sync
 *
 * On-demand rebuild of the client directory (group allocation + churned status +
 * service areas) from the onboarding spreadsheet's "Groups" tab — backs the Move
 * Leads "Sync from sheet" button so an operator can add/edit a client in the sheet
 * and see it reflected immediately instead of waiting for the cron. Admin-gated.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { syncClientDirectory } from "@/lib/client-directory";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const r = await syncClientDirectory();
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: `sync failed: ${(e as Error).message}` }, { status: 502 });
  }
}
