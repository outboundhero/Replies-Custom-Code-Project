/**
 * GET /api/cron/run-move-jobs
 *
 * Drives the durable Lead Mover. Two ways it fires:
 *   - Scheduled every 2 min (vercel.json) with no query → sweeps + resumes any
 *     leasable job (the durable backstop for a stalled/crashed runner).
 *   - Self-trigger / enqueue kick with `?jobId=<id>` → continues that one job.
 * Runs a job until the ~285s budget, then the runner self-triggers so work keeps
 * moving back-to-back with no browser tab involved.
 *
 * Auth: CRON_SECRET (Vercel sends "Authorization: Bearer <CRON_SECRET>"; self-
 * trigger sends x-cron-secret).
 */
import { NextRequest, NextResponse } from "next/server";
import { runLeasable } from "@/lib/leads/run-move-job";
import { logError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const deadlineMs = Date.now() + 285_000;
  const jobId = req.nextUrl.searchParams.get("jobId") || undefined;

  try {
    const r = await runLeasable(deadlineMs, jobId);
    return NextResponse.json({ ok: true, ranJob: r.ranJob });
  } catch (e) {
    await logError("leads-move", "run-move-jobs-cron", (e as Error).message, { jobId }).catch(() => {});
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
