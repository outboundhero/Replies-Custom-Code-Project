/**
 * GET /api/cron/nurture-sync-sequence/[instance]
 *
 * Per-instance sync — gives each Bison instance its own 5-min serverless
 * budget instead of sharing one. With outboundhero having 477 worth-
 * syncing campaigns and Bison rate-limiting per token, the shared
 * /api/cron/nurture-sync-sequence call ran out of budget before
 * outboundhero finished its loop.
 *
 * Routed to via vercel.json cron entries staggered every ~90 minutes so
 * the four instances don't all hit Bison at once.
 *
 * Auth: same CRON_SECRET pattern as the combined route.
 */
import { NextRequest, NextResponse } from "next/server";
import { syncOneInstanceExported } from "@/lib/nurture/sync-sequence-finished";
import { isValidInstance } from "@/lib/bison-instances";
import { logActivity, logError } from "@/lib/errors";

export const maxDuration = 300;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ instance: string }> },
) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { instance } = await params;
  if (!isValidInstance(instance)) {
    return NextResponse.json({ error: `Unknown instance: ${instance}` }, { status: 400 });
  }

  try {
    const result = await syncOneInstanceExported(instance);

    await logActivity("nurture-sync-sequence", "completed-per-instance", {
      details: {
        instance,
        upserted: result.upserted,
        campaigns_scanned: result.campaignsScanned,
        candidates_found: result.candidatesFound,
        error_count: result.errors.length,
      },
    });

    for (const e of result.errors.slice(0, 50)) {
      await logError("nurture-sync-sequence", `instance-error:${instance}`, e);
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    await logError("nurture-sync-sequence", `fatal:${instance}`, (error as Error).message);
    return NextResponse.json({ error: `Sync failed: ${(error as Error).message}` }, { status: 500 });
  }
}
