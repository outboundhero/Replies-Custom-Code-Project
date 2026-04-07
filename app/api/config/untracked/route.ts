import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";

// GET untracked config
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const result = await db.execute("SELECT * FROM untracked_config WHERE id = 1");
    if (result.rows.length === 0) {
      return NextResponse.json(null);
    }
    return NextResponse.json(result.rows[0]);
  } catch (error) {
    console.error("[api/config/untracked] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch untracked config" }, { status: 500 });
  }
}
