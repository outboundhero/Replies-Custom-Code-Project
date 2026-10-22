/**
 * GET /api/cron/hard-reset-jobs
 *
 * Drives clients' Hard Resets (lib/hard-reset/runner.ts): every 2 min (vercel.json)
 * it resumes whatever is under way; with `?id=` (the runner's self-trigger) it
 * continues that reset.
 *
 * Auth: CRON_SECRET (Vercel sends "Authorization: Bearer <CRON_SECRET>"; the
 * self-trigger sends x-cron-secret).
 */
import { NextRequest, NextResponse } from "next/server";
import { runHardResetJobs } from "@/lib/hard-reset/runner";
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
  const id = Number(req.nextUrl.searchParams.get("id")) || undefined;
  try {
    const r = await runHardResetJobs(Date.now() + 285_000, id);
    return NextResponse.json({ ok: true, ran: r.ran });
  } catch (e) {
    await logError("hard-reset", "cron", (e as Error).message, { id }).catch(() => {});
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
