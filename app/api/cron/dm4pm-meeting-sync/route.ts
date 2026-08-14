/**
 * GET /api/cron/dm4pm-meeting-sync
 *
 * DM4PM meeting reconcile (§16/§17/§18). Hourly (vercel.json: "0 * * * *"):
 * scans every live DM4PM subsequence enrollment against the meeting tracker and
 * applies the outcome — booked → pause, attended → stop, qualified no-show →
 * Re-Contact Queue, canceled → return to Open Responses, etc. Idempotent.
 *
 * Auth: CRON_SECRET (Vercel sends "Authorization: Bearer <CRON_SECRET>").
 */
import { NextRequest, NextResponse } from "next/server";
import { runMeetingSyncCron } from "@/lib/dm4pm/run-subsequence";
import { logError } from "@/lib/errors";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runMeetingSyncCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    await logError("dm4pm-subsequence", "meeting-sync-cron", (e as Error).message).catch(() => {});
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
