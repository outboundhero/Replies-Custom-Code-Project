import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";

export async function GET(req: NextRequest) {
  const since = req.nextUrl.searchParams.get("since");
  const limit = req.nextUrl.searchParams.get("limit") || "50";

  let sql = "SELECT * FROM activity_log";
  const args: (string | number)[] = [];

  if (since) {
    sql += " WHERE id > ?";
    args.push(Number(since));
  }

  sql += " ORDER BY id DESC LIMIT ?";
  args.push(Number(limit));

  const result = await db.execute({ sql, args });
  return NextResponse.json(result.rows);
}
