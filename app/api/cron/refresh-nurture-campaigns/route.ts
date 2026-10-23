/**
 * GET /api/cron/refresh-nurture-campaigns?secret=X
 *
 * Snapshots every campaign across all Bison instances into the Turso campaign
 * copies the Nurture pages read (lib/nurture/refresh-campaigns.ts). Every 10 min
 * (Vercel cron); the Nurture pages' "Refresh campaigns" button runs the same thing
 * on demand (/api/nurture/refresh-campaigns).
 */
import { NextRequest, NextResponse } from "next/server";
import { refreshNurtureCampaigns } from "@/lib/nurture/refresh-campaigns";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const r = await refreshNurtureCampaigns();
  if (r.busy) return NextResponse.json({ ok: true, skipped: "another refresh is under way" });
  return NextResponse.json({ ok: true, cached: r.cached, failures: r.failures, revivedCompleted: r.revivedCompleted });
}
