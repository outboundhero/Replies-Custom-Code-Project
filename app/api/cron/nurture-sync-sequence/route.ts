/**
 * GET /api/cron/nurture-sync-sequence
 *
 * Auto-runs the EmailBison sequence-finished sync — finds outbound
 * leads whose sequence completed with no reply and no bounce and adds
 * them to the nurture queue (third source). Scheduled in vercel.json.
 *
 * Auth: same CRON_SECRET pattern as the other cron jobs.
 */

import { NextRequest, NextResponse } from "next/server";
import { syncSequenceFinished } from "@/lib/nurture/sync-sequence-finished";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncSequenceFinished();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[cron/nurture-sync-sequence] failed:", error);
    return NextResponse.json(
      { error: `Sync failed: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}
