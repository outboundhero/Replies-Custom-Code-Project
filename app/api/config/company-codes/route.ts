import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";

export async function GET() {
  const result = await db.execute("SELECT * FROM company_codes ORDER BY priority DESC");
  return NextResponse.json(result.rows);
}

export async function POST(req: NextRequest) {
  const { code, pattern, priority } = await req.json();

  if (!code || !pattern) {
    return NextResponse.json({ error: "code and pattern required" }, { status: 400 });
  }

  const result = await db.execute({
    sql: "INSERT INTO company_codes (code, pattern, priority) VALUES (?, ?, ?)",
    args: [code, pattern, priority || 0],
  });

  return NextResponse.json({ id: Number(result.lastInsertRowid), ok: true });
}

export async function PUT(req: NextRequest) {
  const { id, code, pattern, priority } = await req.json();

  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  await db.execute({
    sql: `UPDATE company_codes SET
            code = COALESCE(?, code),
            pattern = COALESCE(?, pattern),
            priority = COALESCE(?, priority)
          WHERE id = ?`,
    args: [code || null, pattern || null, priority ?? null, id],
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json();

  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  await db.execute({ sql: "DELETE FROM company_codes WHERE id = ?", args: [id] });
  return NextResponse.json({ ok: true });
}
