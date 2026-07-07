import { NextRequest, NextResponse } from "next/server";
import { syncAll } from "@/lib/sync/sheets-to-supabase";
import { syncServiceAreas } from "@/lib/service-area";

export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") || req.nextUrl.searchParams.get("secret");

  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncAll();
    // Keep the Lead Mover's service-area table fresh on every sheet sync too
    // (non-fatal — a failure here must not fail the primary sync).
    const serviceArea = await syncServiceAreas().catch(() => null);
    return NextResponse.json({ ok: true, ...result, serviceArea: serviceArea?.withArea ?? null });
  } catch (error) {
    console.error("[cron/sync-sheets] Sync failed:", error);
    return NextResponse.json(
      { error: `Sync failed: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}
