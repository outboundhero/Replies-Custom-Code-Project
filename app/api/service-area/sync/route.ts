/**
 * POST /api/service-area/sync  { clientTag }
 *
 * On-demand service-area sync for a SINGLE client — backs the Move Leads
 * "Sync service area" button so operators don't wait for the 12h cron after an
 * onboarding-sheet edit. Admin-gated. Returns the freshly-parsed area (or null).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { syncServiceAreaForClient } from "@/lib/service-area";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { clientTag?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const clientTag = String(body.clientTag || "").trim();
  if (!clientTag) return NextResponse.json({ error: "clientTag required" }, { status: 400 });

  try {
    const area = await syncServiceAreaForClient(clientTag);
    return NextResponse.json({ ok: true, serviceArea: area ? { raw: area.raw, cities: area.tokens } : null });
  } catch (e) {
    return NextResponse.json({ error: `sync failed: ${(e as Error).message}` }, { status: 502 });
  }
}
