/**
 * GET /api/cron/refresh-nurture-results
 *
 * Rebuilds "what nurture produces": every lead delivered to a client (pushed to
 * its lead sheet), credited to the campaign stage it came from — Main, Nurture 1,
 * Nurture 2, … (lib/nurture/results.ts). Holds the system-wide heavy-query lease
 * and stands down when the shared database is busy, so it never competes with
 * the inbox. Every 6 hours via vercel.json; then the overview snapshot is rebuilt
 * so its "delivered in the last 90 days" column follows.
 */
import { NextRequest, NextResponse } from "next/server";
import { refreshDeliveredLeads } from "@/lib/nurture/results";
import { rebuildOverviewSnapshot } from "@/lib/nurture/overview-snapshot";
import { logError } from "@/lib/errors";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const r = await refreshDeliveredLeads();
    if (r.ok) {
      try { await rebuildOverviewSnapshot(); } catch (e) { console.error("[cron/refresh-nurture-results] overview rebuild failed:", (e as Error).message); }
    }
    return NextResponse.json(r);
  } catch (e) {
    await logError("nurture-results", "refresh", (e as Error).message).catch(() => undefined);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
