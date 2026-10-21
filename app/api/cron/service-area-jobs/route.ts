/**
 * GET /api/cron/service-area-jobs
 *
 * Drives service-area changes: the read-only scan, and — on the removal day,
 * only for approved changes — the removal, its 10-minute verification and the
 * 7-day re-check. Every 2 min (vercel.json) it resumes whatever is due; with
 * `?changeId=` (the runner's self-trigger) it continues that change.
 *
 * Auth: CRON_SECRET (Vercel sends "Authorization: Bearer <CRON_SECRET>"; self-
 * trigger sends x-cron-secret).
 */
import { NextRequest, NextResponse } from "next/server";
import { runServiceAreaJobs } from "@/lib/service-area-changes/runner";
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
  const changeId = Number(req.nextUrl.searchParams.get("changeId")) || undefined;
  try {
    const r = await runServiceAreaJobs(deadlineMs, changeId);
    return NextResponse.json({ ok: true, ran: r.ran });
  } catch (e) {
    await logError("service-area", "cron", (e as Error).message, { changeId }).catch(() => {});
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
