/**
 * GET /api/cron/sync-service-areas?secret=X
 *
 * Reads the Onboarding Form sheet's "Inclusion Locations" per client, parses the
 * city/town tokens (dropping states/ZIPs/counties), and replaces the Turso
 * `client_service_area` table. The Lead Mover's service-area gate reads it via
 * lib/service-area.ts to skip out-of-area leads.
 *
 * Wired to a 12-hourly Vercel cron; also callable manually after the sheet changes.
 */
import { NextRequest, NextResponse } from "next/server";
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
    const { count, withArea, tags } = await syncServiceAreas();
    return NextResponse.json({ ok: true, clients: count, withArea, sample: tags.slice(0, 10) });
  } catch (e) {
    return NextResponse.json({ error: `sheet read failed: ${(e as Error).message}` }, { status: 502 });
  }
}
