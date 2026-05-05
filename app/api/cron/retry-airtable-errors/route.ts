/**
 * GET /api/cron/retry-airtable-errors
 *
 * Auto-retries airtable-stage errors that piled up since the last run,
 * then sweeps any orphan webhook-stage rows. Scheduled in vercel.json —
 * fires every 2 hours.
 *
 * Auth: requires CRON_SECRET (same as other cron jobs). Vercel cron sends
 * it in the Authorization header as "Bearer <CRON_SECRET>".
 *
 * Bounded by Vercel's maxDuration. Each run processes as much as it can
 * inside the deadline; remaining errors get picked up on the next run.
 */

import { NextRequest, NextResponse } from "next/server";
import { retryAirtableErrorsBatch, cleanupOrphanWebhookErrors } from "@/lib/errors/auto-retry";

// Each retry replays the full processing pipeline (Airtable + Supabase
// + classifier + Clay). At ~1.5/s with concurrency 5, 60s = ~90 retries
// per run — comfortably within Vercel's hobby/Pro 60s default. Bumping
// to 300s if the user is on Pro would let one run drain ~450 errors.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Leave a 5s buffer before maxDuration so the response can return
  // cleanly even if a retry is mid-flight.
  const deadlineMs = Date.now() + (maxDuration - 5) * 1000;

  try {
    const retryResult = await retryAirtableErrorsBatch({
      concurrency: 5,
      deadlineMs,
    });

    const cleanupResult = await cleanupOrphanWebhookErrors();

    return NextResponse.json({
      ok: true,
      retry: retryResult,
      cleanup: cleanupResult,
    });
  } catch (error) {
    console.error("[cron/retry-airtable-errors] failed:", error);
    return NextResponse.json(
      { error: `Retry cron failed: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}
