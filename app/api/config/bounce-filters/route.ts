import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";

export async function GET() {
  try {
    const result = await db.execute("SELECT * FROM bounce_filters ORDER BY id");
    return NextResponse.json(result.rows);
  } catch (error) {
    console.error("[api/config/bounce-filters] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch bounce filters" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { field, value, match_type } = await req.json();

    if (!field || !value) {
      return NextResponse.json({ error: "field and value required" }, { status: 400 });
    }

    const result = await db.execute({
      sql: "INSERT INTO bounce_filters (field, value, match_type) VALUES (?, ?, ?)",
      args: [field, value, match_type || "notContains"],
    });

    return NextResponse.json({ id: Number(result.lastInsertRowid), ok: true });
  } catch (error) {
    console.error("[api/config/bounce-filters] POST failed:", error);
    return NextResponse.json({ error: "Failed to create bounce filter" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json();

    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }

    await db.execute({ sql: "DELETE FROM bounce_filters WHERE id = ?", args: [id] });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[api/config/bounce-filters] DELETE failed:", error);
    return NextResponse.json({ error: "Failed to delete bounce filter" }, { status: 500 });
  }
}
