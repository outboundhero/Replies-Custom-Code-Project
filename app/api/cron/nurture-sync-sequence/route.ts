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
import { logActivity, logError } from "@/lib/errors";

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

    // Persist per-instance summary so silent failures (token expiry,
    // network errors, zero-row syncs) are catchable from activity_log.
    // Without this, the cron's result is only visible in Vercel's log
    // viewer — easy to miss for days.
    await logActivity("nurture-sync-sequence", "completed", {
      details: {
        upserted: result.upserted,
        campaigns_scanned: result.campaignsScanned,
        candidates_found: result.candidatesFound,
        per_instance: result.perInstance.map((p) => ({
          instance: p.instance,
          campaigns: p.campaignsScanned,
          candidates: p.candidatesFound,
          upserted: p.upserted,
          error_count: p.errors.length,
        })),
      },
    });

    // Persist each error individually so they're queryable from the
    // error log UI alongside other Bison failures.
    for (const e of result.errors.slice(0, 50)) {
      await logError("nurture-sync-sequence", "instance-error", e);
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    await logError("nurture-sync-sequence", "fatal", (error as Error).message);
    console.error("[cron/nurture-sync-sequence] failed:", error);
    return NextResponse.json(
      { error: `Sync failed: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}
