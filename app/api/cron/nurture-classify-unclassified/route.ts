/**
 * GET /api/cron/nurture-classify-unclassified
 *
 * Auto-runs the safety classifier on rows that don't have nurture_safety
 * set yet. One run = up to 200 replies + 200 legacy rows (concurrency 8).
 * Scheduled in vercel.json — fires every 5 minutes.
 *
 * Auth: requires the same CRON_SECRET that protects the other cron jobs.
 *   Header: x-cron-secret: <secret>
 *   Or:     ?secret=<secret>
 *
 * Vercel sets the Authorization header automatically for scheduled cron
 * invocations using CRON_SECRET, so no extra config is needed once the
 * env var is set.
 */

import { NextRequest, NextResponse } from "next/server";
import { classifyOneBatch } from "@/lib/nurture/auto-classify";

// One batch = up to 400 GPT calls; 60s is enough at concurrency 8.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    // Vercel cron sends the secret in the Authorization header as
    // "Bearer <CRON_SECRET>". Strip the "Bearer " prefix.
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await classifyOneBatch();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[cron/nurture-classify-unclassified] failed:", error);
    return NextResponse.json(
      { error: `Classify failed: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}
