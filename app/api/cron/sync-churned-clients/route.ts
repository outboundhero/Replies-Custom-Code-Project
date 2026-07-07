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

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { count, tags } = await rebuildChurnedClients();
    // Refresh the Lead Mover's service-area table on this sync too (non-fatal).
    const serviceArea = await syncServiceAreas().catch(() => null);
    return NextResponse.json({ ok: true, churned: count, tags, serviceArea: serviceArea?.withArea ?? null });
  } catch (e) {
    return NextResponse.json({ error: `sheet read failed: ${(e as Error).message}` }, { status: 502 });
  }
}
