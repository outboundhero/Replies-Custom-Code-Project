/**
 * GET /api/nurture/overview[?fresh=1][&since=<builtAt>] — everything the
 * Nurture overview page shows, served from the precomputed snapshot (one Turso
 * read; the crons rebuild it every ~10 min, and a read older than 15 min also
 * triggers a background rebuild). ?fresh=1
 * rebuilds first. ?since=<builtAt the page already has> → { unchanged: true }
 * when nothing was rebuilt since (the page polls; skips the ~250KB payload).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getOverview, overviewPayload, snapshotBuiltAt, scheduleOverviewRebuild } from "@/lib/nurture/overview-snapshot";

// Runs next to Turso (Mumbai): each read is one short hop, not a trip from the US.
export const preferredRegion = "bom1";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const fresh = req.nextUrl.searchParams.get("fresh") === "1";
    const since = req.nextUrl.searchParams.get("since");
    if (since && !fresh) {
      const at = await snapshotBuiltAt();
      if (at === since) {
        if (Date.now() - new Date(at).getTime() > 15 * 60_000) scheduleOverviewRebuild({ ifOlderThanMs: 15 * 60_000 });
        return NextResponse.json({ unchanged: true, builtAt: at });
      }
    }
    const o = await getOverview({ fresh });
    return NextResponse.json(overviewPayload(o));
  } catch (e) {
    console.error("[api/nurture/overview]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
