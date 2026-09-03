/**
 * GET /api/cron/nurture-recover-stopped?secret=X
 *
 * Ongoing recovery of `sequence_stopped` leads (stopped for "Unknown reason" or
 * "Associated sender being deleted/moved") back into each client's confirmed
 * nurture map. Least-recently-run-first rotation, soft time budget, per-client
 * cap. Idempotent: every recovered email is stamped in nurture_stopped_recovered,
 * so no lead is ever re-added. See lib/nurture/recover-stopped.ts.
 *
 * Query params:
 *   ?dry=1        — compute + report without touching Bison or the ledger
 *   ?backfill=1   — widen scope to archived campaigns (the one-time backfill pass)
 *   ?limit=N      — cap how many clients this run touches (default 8)
 *   ?cap=N        — cap candidate leads routed per client this run (default 500)
 */
import { NextRequest, NextResponse } from "next/server";
import { runRecoverStoppedSweep } from "@/lib/nurture/recover-stopped";
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
  const backfill = ["1", "true", "yes"].includes((sp.get("backfill") || "").toLowerCase());
  const limit = sp.get("limit") ? Math.max(1, Number(sp.get("limit")) || 0) : 8;
  const cap = sp.get("cap") ? Math.max(1, Number(sp.get("cap")) || 0) : 500;

  try {
    const res = await runRecoverStoppedSweep({ dry, backfill, limit, capPerClient: cap, maxMs: 270_000 });
    const totals = res.results.reduce(
      (a, r) => ({
        eligible: a.eligible + r.eligible,
        attached: a.attached + r.attached,
        blacklisted: a.blacklisted + r.excludedBlacklisted,
        bounced: a.bounced + r.excludedBounced,
        alreadyRecovered: a.alreadyRecovered + r.excludedAlreadyRecovered,
      }),
      { eligible: 0, attached: 0, blacklisted: 0, bounced: 0, alreadyRecovered: 0 },
    );
    return NextResponse.json({
      ok: true,
      dry,
      backfill,
      checked: res.checked,
      budgetHit: res.budgetHit,
      totals,
      results: res.results.map((r) => ({
        tag: r.clientTag, eligible: r.eligible, attached: r.attached,
        uniqueStopped: r.uniqueStopped, bounced: r.excludedBounced, replied: r.excludedReplied,
        alreadyRecovered: r.excludedAlreadyRecovered, sheetMeetingReady: r.excludedSheetMeetingReady,
        budgetHit: r.budgetHit ?? false, noMap: r.noMap ?? false, error: r.error,
      })),
    });
  } catch (e) {
    await logError("nurture-recover-stopped", "cron", (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
