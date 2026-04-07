import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const since = req.nextUrl.searchParams.get("since");
    const limit = req.nextUrl.searchParams.get("limit") || "5000";
    const workflow = req.nextUrl.searchParams.get("workflow");

    // Fetch single error with payload via ?id= param
    const id = req.nextUrl.searchParams.get("id");
    if (id) {
      const result = await db.execute({ sql: "SELECT * FROM error_log WHERE id = ?", args: [Number(id)] });
      return NextResponse.json(result.rows[0] || null);
    }

    // List query excludes payload to avoid Turso response size limits
    let sql = "SELECT id, timestamp, workflow, stage, message, (payload IS NOT NULL) as has_payload FROM error_log";
    const args: (string | number)[] = [];
    const conditions: string[] = [];

    if (since) {
      conditions.push("id > ?");
      args.push(Number(since));
    }

    if (workflow) {
      conditions.push("workflow = ?");
      args.push(workflow);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY id DESC LIMIT ?";
    args.push(Number(limit));

    const result = await db.execute({ sql, args });
    return NextResponse.json(result.rows);
  } catch (error) {
    console.error("[api/errors] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch errors" }, { status: 500 });
  }
}