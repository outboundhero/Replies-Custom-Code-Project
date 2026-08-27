/**
 * GET /api/cron/onboarding-digest — once a day, DM each onboarding owner their
 * Overdue + Due-today tasks. Auth: CRON_SECRET (Bearer / x-cron-secret / ?secret).
 */
import { NextRequest, NextResponse } from "next/server";
import { sendDailyDigest } from "@/lib/onboarding/notify";
import { logActivity, logError } from "@/lib/errors";

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const res = await sendDailyDigest();
    await logActivity("onboarding-digest", "sent", { details: res });
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    await logError("onboarding-digest", "run", (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
