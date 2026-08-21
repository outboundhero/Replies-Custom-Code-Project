/**
 * GET /api/cron/retry-close-pushes — auto-retry pending OH → Close.com push
 * failures so a transient Close API blip self-heals without anyone touching it.
 * A row that succeeds is cleared; one that keeps failing stays visible in Error
 * Logs. Runs every 15 minutes.
 *
 * Auth: CRON_SECRET (Bearer / x-cron-secret / ?secret).
 */
import { NextRequest, NextResponse } from "next/server";
import { retryClosePushes } from "@/lib/close-crm";
import { logActivity } from "@/lib/errors";

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const r = await retryClosePushes();
  if (r.processed) {
    await logActivity("close-push-retry", "run", { details: r });
  }
  return NextResponse.json({ ok: true, ...r });
}
