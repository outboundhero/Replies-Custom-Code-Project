/**
 * GET /api/cron/nurture-activation-gate?secret=X
 *
 * The nurture 80% activation gate (fire-once). For each active, non-churned
 * client tag (oldest-checked-first rotation, soft time budget):
 *   - already fired            → skip forever
 *   - main completion >= 80%   → FIRE: record + activate ready nurture
 *   - main completion <  80%   → pause any currently-sending nurture campaign
 *
 * Scheduled every 2h in vercel.json, offset from nurture-auto-push. Also
 * callable manually (used for the one-time rollout). See
 * lib/nurture/activation-gate.ts.
 *
 * Query params:
 *   ?dry=1    — evaluate + report without mutating Bison / the gate tables
 *   ?limit=N  — cap how many tags this run touches (default: all within budget)
 */
import { NextRequest, NextResponse } from "next/server";
import { runActivationGate } from "@/lib/nurture/activation-gate";
import { logError } from "@/lib/errors";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dryRun = ["1", "true", "yes"].includes((req.nextUrl.searchParams.get("dry") || "").toLowerCase());
  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = limitRaw ? Math.max(1, Number(limitRaw) || 0) : undefined;

  try {
    const res = await runActivationGate({ dryRun, maxMs: 270_000, limit });
    // Compact per-action tally for the response.
    const tally: Record<string, number> = {};
    for (const r of res.results) tally[r.action] = (tally[r.action] ?? 0) + 1;
    return NextResponse.json({
      ok: true,
      dryRun,
      checked: res.checked,
      softBudgetHit: res.softBudgetHit,
      tally,
      results: res.results,
    });
  } catch (e) {
    await logError("nurture-activation-gate", "cron", (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
