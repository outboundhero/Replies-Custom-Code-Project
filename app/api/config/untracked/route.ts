import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { withCache, nsVersion } from "@/lib/server-cache";

// GET untracked config
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const row = await withCache(`config:untracked:v${nsVersion("config")}`, 60_000, async () => {
      const result = await db.execute("SELECT * FROM untracked_config WHERE id = 1");
      return result.rows.length ? result.rows[0] : null;
    });
    return NextResponse.json(row);
  } catch (error) {
    console.error("[api/config/untracked] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch untracked config" }, { status: 500 });
  }
}
