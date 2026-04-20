import { NextRequest, NextResponse } from "next/server";
import { syncClientSheets } from "@/lib/sync/sheets-sync";

export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") || req.nextUrl.searchParams.get("secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const count = await syncClientSheets();
    return NextResponse.json({ ok: true, count });
  } catch (error) {
    console.error("[cron/sync-client-sheets] failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
