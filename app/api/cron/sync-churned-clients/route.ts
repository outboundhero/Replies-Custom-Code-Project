/**
 * GET /api/cron/sync-churned-clients?secret=X
 *
 * Reads the Client Tracker sheet, computes the churned set (Status="Churned"
 * AND a Churn Date), and replaces the Turso `churned_clients` table. The
 * nurture page + workflows read it via lib/churn.ts to skip churned clients.
 *
 * Wire to a daily-ish Vercel cron; also callable manually after the sheet
 * changes.
 */
import { NextRequest, NextResponse } from "next/server";
import { rebuildChurnedClients } from "@/lib/churn";
import { syncServiceAreas } from "@/lib/service-area";
import { pacificHour } from "@/lib/pacific-time";
import { activeClientTags, setCronState } from "@/lib/nurture/overview";
import { rebuildOverviewSnapshot } from "@/lib/nurture/overview-snapshot";

// Client decision (2026-10): Sync Churned runs daily at 8:00 AM and 12:00 PM
// Pacific. vercel.json fires at both candidate UTC hours (PST/PDT); ?pt=1 makes
// the route run only when it's actually 8 or 12 o'clock Pacific.
const PACIFIC_HOURS = [8, 12];

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (req.nextUrl.searchParams.get("pt") === "1" && !PACIFIC_HOURS.includes(pacificHour())) {
    return NextResponse.json({ ok: true, skipped: `not ${PACIFIC_HOURS.join(" / ")}:00 Pacific` });
  }

  try {
    const { count, tags } = await rebuildChurnedClients();
    // Refresh the Lead Mover's service-area table on this sync too (non-fatal).
    const serviceArea = await syncServiceAreas().catch(() => null);
    // Shown on the Nurture overview's "Sync Churned" card.
    try {
      const { tags: active } = await activeClientTags();
      await setCronState("nurture:churn-sync", { at: new Date().toISOString(), churned: count, active: active.length });
      await rebuildOverviewSnapshot();
    } catch { /* display-only */ }
    return NextResponse.json({ ok: true, churned: count, tags, serviceArea: serviceArea?.withArea ?? null });
  } catch (e) {
    return NextResponse.json({ error: `sheet read failed: ${(e as Error).message}` }, { status: 502 });
  }
}
