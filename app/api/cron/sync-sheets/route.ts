import { NextRequest, NextResponse } from "next/server";
import { syncAll } from "@/lib/sync/sheets-to-supabase";

export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") || req.nextUrl.searchParams.get("secret");

  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncAll();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[cron/sync-sheets] Sync failed:", error);
    return NextResponse.json(
      { error: `Sync failed: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}
