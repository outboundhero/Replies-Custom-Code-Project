/**
 * GET /api/cron/dm4pm-subsequence
 *
 * DM4PM interested-reply subsequence step sender (§8/§10/§12/§26). Every 15 min
 * (vercel.json: "*\/15 * * * *"): wakes expired snoozes, then drains every due
 * step and every elapsed inbox-response continuation timer, running the pre-send
 * safety check and sending each step in-thread (failover to a new thread + new
 * sender when the original inbox is dead).
 *
 * Auth: CRON_SECRET (Vercel sends "Authorization: Bearer <CRON_SECRET>").
 */
import { NextRequest, NextResponse } from "next/server";
import { runStepCron } from "@/lib/dm4pm/run-subsequence";
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
    const result = await runStepCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    await logError("dm4pm-subsequence", "step-cron", (e as Error).message).catch(() => {});
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
