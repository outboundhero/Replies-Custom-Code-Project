/**
 * POST /api/nurture/refresh-stats { tag } — "Refresh numbers" for one client:
 * recompute its queue stats (heavy — at most once a minute per client, and
 * only when no other heavy Nurture query is running; otherwise it's queued for
 * the next stats run) + its last contact (Bison), then rebuild the overview.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { refreshTagStatsNow, refreshLastContact } from "@/lib/nurture/overview";
import { rebuildOverviewSnapshot } from "@/lib/nurture/overview-snapshot";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const tag = String(body?.tag || "").trim();
  if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });
  try {
    const [stats, last] = await Promise.all([refreshTagStatsNow(tag), refreshLastContact({ tag, maxMs: 60_000 })]);
    await rebuildOverviewSnapshot({ force: true }); // the page reloads right after — serve the new numbers
    return NextResponse.json({ ok: true, stats: stats.status, statsError: stats.error, lastContactChecked: last.checked });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
