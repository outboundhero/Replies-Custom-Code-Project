import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";

export async function GET(req: NextRequest) {
  try {
    const since = req.nextUrl.searchParams.get("since");
    const limit = req.nextUrl.searchParams.get("limit") || "5000";
    const workflow = req.nextUrl.searchParams.get("workflow");

    let sql = "SELECT * FROM error_log";
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

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json();

    if (id) {
      await db.execute({ sql: "DELETE FROM error_log WHERE id = ?", args: [id] });
    } else {
      await db.execute("DELETE FROM error_log");
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[api/errors] DELETE failed:", error);
    return NextResponse.json({ error: "Failed to delete errors" }, { status: 500 });
  }
}
