import { NextRequest, NextResponse } from "next/server";
import { retryLeadRushNotifications } from "@/lib/leadrush";

export const maxDuration = 60;

/** Re-send pending LeadRush notifications (failed attempts, or queued before
 *  LEADRUSH_NOTIFY_SECRET was configured). Every 10 minutes via vercel.json. */
export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await retryLeadRushNotifications();
  return NextResponse.json({ ok: true, ...result });
}
