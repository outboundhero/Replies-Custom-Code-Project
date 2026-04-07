import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";

// POST — handles create and delete via `action` field
export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const body = await req.json();
    const { action } = body;

    // --- CREATE (default when no action specified) ---
    if (!action || action === "create") {
      const { field, value, match_type } = body;

      if (!field || !value) {
        return NextResponse.json({ error: "field and value required" }, { status: 400 });
      }

      const result = await db.execute({
        sql: "INSERT INTO bounce_filters (field, value, match_type) VALUES (?, ?, ?)",
        args: [field, value, match_type || "notContains"],
      });

      return NextResponse.json({ id: Number(result.lastInsertRowid), ok: true });
    }

    // --- DELETE ---
    if (action === "delete") {
      const { id } = body;

      if (!id) {
        return NextResponse.json({ error: "id required" }, { status: 400 });
      }

      await db.execute({ sql: "DELETE FROM bounce_filters WHERE id = ?", args: [id] });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    console.error("[api/config/bounce-filters/mutate] POST failed:", error);
    return NextResponse.json({ error: "Failed to process bounce filter request" }, { status: 500 });
  }
}
