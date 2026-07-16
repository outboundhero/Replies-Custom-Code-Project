import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { bumpVersion } from "@/lib/server-cache";
import { syncAll } from "@/lib/sync/sheets-to-supabase";

export async function POST() {
  const denied = await requireAuth();
  if (denied) return denied;
  bumpVersion("config");

  try {
    const result = await syncAll();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[api/sync/sheets] Sync failed:", error);
    return NextResponse.json(
      { error: `Sync failed: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}
