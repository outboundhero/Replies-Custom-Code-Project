/**
 * GET /api/cron/nurture-auto-map?secret=X
 *
 * Makes nurture-campaign mapping fully automatic — no manual trigger:
 *   - a NEW active client that isn't mapped yet is auto-mapped (its 3 nurture
 *     campaigns identified by name + provider) and confirmed → sending enabled.
 *   - a RETURNING (re-onboarded) client whose confirmed map points at old
 *     paused/archived campaigns is re-pointed to its LATEST live campaigns.
 * Rotation cursor (least-recently-run first) + soft time budget. Idempotent.
 * Operators can still change any mapping by hand. See lib/nurture/auto-map.ts.
 *
 * Query params:
 *   ?dry=1     — report what WOULD change without writing
 *   ?limit=N   — cap clients touched this run (default 25)
 */
import { NextRequest, NextResponse } from "next/server";
import { runAutoMapSweep } from "@/lib/nurture/auto-map";
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
  const limit = sp.get("limit") ? Math.max(1, Number(sp.get("limit")) || 0) : 25;

  try {
    const res = await runAutoMapSweep({ dryRun: dry, limit, maxMs: 270_000 });
    return NextResponse.json({
      ok: true,
      dry,
      checked: res.checked,
      budgetHit: res.budgetHit,
      newlyMappedCount: res.newlyMapped.length,
      remappedCount: res.remapped.length,
      newlyMapped: res.newlyMapped,
      remapped: res.remapped,
    });
  } catch (e) {
    await logError("nurture-auto-map", "cron", (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
