import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const result = await db.execute("SELECT * FROM company_codes ORDER BY priority DESC");
    return NextResponse.json(result.rows);
  } catch (error) {
    console.error("[api/config/company-codes] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch company codes" }, { status: 500 });
  }
}
