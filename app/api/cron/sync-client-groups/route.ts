/**
 * GET /api/cron/sync-client-groups?secret=X
 *
 * Rebuilds the client directory from the "Groups" tab of the onboarding-form-
 * responses spreadsheet — group allocation (`client_groups`), churned status
 * (`churned_clients`, Status=Churned AND churn date passed), and service areas
 * (`client_service_area`). Nurture routing + the Lead Mover + the churn gate all
 * read these tables.
 *
 * Wired to a Vercel cron; also callable manually (and by the Move-Leads "Sync from
 * sheet" button via /api/groups/sync, which shares the same syncClientDirectory).
 */
import { NextRequest, NextResponse } from "next/server";
import { syncClientDirectory } from "@/lib/client-directory";

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
    const r = await syncClientDirectory();
    return NextResponse.json({
      ok: true,
      groups: r.groups.count,
      group1: r.groups.g1,
      group2: r.groups.g2,
      churned: r.churn.count,
      churnedTags: r.churn.tags,
      serviceAreaWithArea: r.serviceArea?.withArea ?? null,
    });
  } catch (e) {
    return NextResponse.json({ error: `sync failed: ${(e as Error).message}` }, { status: 502 });
  }
}
