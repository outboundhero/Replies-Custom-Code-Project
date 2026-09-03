/**
 * GET /api/cron/activate-campaigns?secret=X
 *
 * Keeps eligible clients' Main + Nurture campaigns Active: resumes every
 * draft/paused campaign that is sendable (>=1 lead AND >=1 connected inbox).
 * Rotation cursor (least-recently-run first) + soft time budget, so the fleet is
 * covered over several runs. Idempotent (resuming an active campaign is a no-op).
 * See lib/campaign-activation.ts.
 *
 * Query params:
 *   ?dry=1     — report what WOULD activate without resuming
 *   ?limit=N   — cap how many clients this run touches (default 12)
 */
import { NextRequest, NextResponse } from "next/server";
import { runActivationSweep } from "@/lib/campaign-activation";
import { logError } from "@/lib/errors";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const dry = ["1", "true", "yes"].includes((sp.get("dry") || "").toLowerCase());
  const limit = sp.get("limit") ? Math.max(1, Number(sp.get("limit")) || 0) : 12;

  try {
    const res = await runActivationSweep({ dryRun: dry, limit, maxMs: 270_000 });
    const totals = res.results.reduce(
      (a, r) => ({ activated: a.activated + r.activated, blocked: a.blocked + r.blocked, failed: a.failed + r.failed }),
      { activated: 0, blocked: 0, failed: 0 },
    );
    return NextResponse.json({
      ok: true,
      dry,
      checked: res.checked,
      budgetHit: res.budgetHit,
      totals,
      results: res.results.filter((r) => r.activated || r.failed || r.error)
        .map((r) => ({ tag: r.tag, activated: r.activated, blocked: r.blocked, failed: r.failed, error: r.error })),
    });
  } catch (e) {
    await logError("campaign-activation", "cron", (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
