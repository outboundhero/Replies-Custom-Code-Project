import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const result = await db.execute("SELECT * FROM bounce_filters ORDER BY id");
    return NextResponse.json(result.rows);
  } catch (error) {
    console.error("[api/config/bounce-filters] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch bounce filters" }, { status: 500 });
  }
}
