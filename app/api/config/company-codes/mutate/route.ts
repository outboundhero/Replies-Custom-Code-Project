import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";

// POST — handles create, update, and delete via `action` field
export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const body = await req.json();
    const { action } = body;

    // --- CREATE (default when no action specified) ---
    if (!action || action === "create") {
      const { code, pattern, priority } = body;

      if (!code || !pattern) {
        return NextResponse.json({ error: "code and pattern required" }, { status: 400 });
      }

      const result = await db.execute({
        sql: "INSERT INTO company_codes (code, pattern, priority) VALUES (?, ?, ?)",
        args: [code, pattern, priority || 0],
      });

      return NextResponse.json({ id: Number(result.lastInsertRowid), ok: true });
    }

    // --- UPDATE ---
    if (action === "update") {
      const { id, code, pattern, priority } = body;

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

    // --- DELETE ---
    if (action === "delete") {
      const { id } = body;

      if (!id) {
        return NextResponse.json({ error: "id required" }, { status: 400 });
      }

      await db.execute({ sql: "DELETE FROM company_codes WHERE id = ?", args: [id] });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    console.error("[api/config/company-codes/mutate] POST failed:", error);
    return NextResponse.json({ error: "Failed to process company code request" }, { status: 500 });
  }
}
