/**
 * GET /api/cron/nurture-auto-push
 *
 * The "completely automate nurture" cron. For every client that has
 * auto-push enabled (typically because they clicked the Auto-route
 * button at least once), this runs the same auto-route logic the UI
 * does: pull newly-eligible Ready leads, partition by ESP, push each
 * bucket to its canonical Bison campaign, stamp added_at + log.
 *
 * Schedule: every 2 hours (vercel.json). Per-client wall-clock budget
 * keeps each tick comfortably inside the 5-min route limit even with
 * many enabled clients.
 *
 * Auth: same CRON_SECRET pattern as the other cron jobs.
 */

import { NextRequest, NextResponse } from "next/server";
import { listAutoEnabledClients, runAutoPushForClient } from "@/lib/nurture/auto-push";
import { logActivity, logError } from "@/lib/errors";

export const maxDuration = 300;

const SOFT_BUDGET_MS = 4.5 * 60 * 1000; // 270s — leaves 30s for log/return

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const tags = await listAutoEnabledClients();
  const summary: Array<{ tag: string; scanned: number; attached: number; buckets: number; errors: number }> = [];

  // Process clients sequentially. Bison API rate-limits per token, so
  // running them in parallel would just thrash the limit. The wall-
  // clock budget below stops us before the 5-min route ceiling.
  for (const tag of tags) {
    if (Date.now() - startedAt > SOFT_BUDGET_MS) {
      await logActivity("nurture-auto-push", "soft-budget-hit", {
        details: {
          processed: summary.length,
          remaining: tags.length - summary.length,
          message: "Soft budget hit — remaining clients will be picked up on the next tick.",
        },
      });
      break;
    }
    try {
      const r = await runAutoPushForClient(tag);
      summary.push({
        tag, scanned: r.scanned, attached: r.totalAttached,
        buckets: r.perBucket.length,
        errors: r.perBucket.filter((b) => b.error).length + (r.error ? 1 : 0),
      });
    } catch (e) {
      await logError("nurture-auto-push", `fatal:${tag}`, (e as Error).message);
      summary.push({ tag, scanned: 0, attached: 0, buckets: 0, errors: 1 });
    }
  }

  await logActivity("nurture-auto-push", "completed", {
    details: {
      clients_processed: summary.length,
      total_attached: summary.reduce((s, x) => s + x.attached, 0),
      summary,
    },
  });

  return NextResponse.json({ ok: true, processed: summary.length, summary });
}
