/**
 * GET /api/cron/refresh-nurture-overview
 *
 * Keeps the Nurture overview's slower numbers fresh in the background so the
 * page itself never waits on them:
 *   1. per-tag queue stats (Supabase nurture_tag_stats — a few seconds per tag),
 *      stalest tags first, cached in Turso nurture_tag_stats_cache;
 *   2. "last contact" — the newest send day of each active nurture campaign
 *      (Bison line-area-chart, ~1s each), stalest first.
 * Both rotate within a time budget (stats: one tag at a time, only tags older
 * than 3h — they're heavy queries on the database the inbox shares), so every
 * tag is refreshed every few hours and every campaign every few runs. Every
 * 10 minutes via vercel.json.
 *
 * ?tag=X refreshes just that client (both parts) — used after queue changes.
 */
import { NextRequest, NextResponse } from "next/server";
import { refreshTagStats, refreshLastContact, refreshTagOverlap } from "@/lib/nurture/overview";
import { pacificHour } from "@/lib/pacific-time";
import { rebuildOverviewSnapshot } from "@/lib/nurture/overview-snapshot";
import { logError } from "@/lib/errors";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const tag = req.nextUrl.searchParams.get("tag") || undefined;
  const started = Date.now();
  try {
    // Light on the shared database: one tag at a time, ~60s of work per run,
    // only tags whose numbers are > 3h old (a full rotation fits well inside
    // that). Last contact (Bison only) gets the rest of the budget.
    const stats = await refreshTagStats(tag ? { tags: [tag] } : { maxTags: 60, maxMs: 60_000, minAgeMs: 3 * 3_600_000, yieldToLoad: true });
    // A big tag started near the stats budget can still run ~2-3 min, so give
    // last contact only what's left of a 270s envelope (maxDuration 300s).
    const left = 270_000 - (Date.now() - started);
    const lastContact = left < 10_000
      ? { checked: 0, failed: 0, skipped: "out of time" }
      : await refreshLastContact(tag ? { tag, maxMs: left } : { maxCampaigns: 120, maxMs: Math.min(90_000, left), minAgeMs: 2 * 3_600_000 });
    // Overnight (0–6 AM Pacific) only: the heavy "Overlapping" counts.
    const overlap = !tag && pacificHour() < 6
      ? await refreshTagOverlap({ finishBy: started + 285_000 }) // leaves time for the snapshot rebuild
      : { refreshed: [] as string[], skipped: tag ? "single client" : "daytime" };
    await rebuildOverviewSnapshot(); // pages read this precomputed copy
    if (stats.busy) console.log("[cron/refresh-nurture-overview] stats skipped: another heavy query holds the lease");
    if (stats.failed.length) {
      // Self-healing (retried after an hour) — log, but keep it out of the Error Log.
      console.error("[cron/refresh-nurture-overview] stats failed:", stats.failed.slice(0, 5));
    }
    return NextResponse.json({ ok: true, statsRefreshed: stats.refreshed.length, statsBusy: !!stats.busy, statsYielded: !!stats.yielded, statsFailed: stats.failed, lastContact, overlap: { refreshed: overlap.refreshed.length, skipped: overlap.skipped } });
  } catch (e) {
    await logError("nurture-overview", "cron", (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
