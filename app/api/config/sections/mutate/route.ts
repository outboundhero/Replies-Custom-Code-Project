import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";

// POST — create / update / delete section (action field dispatches)
export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const body = await req.json();
    const { action } = body;

    // --- CREATE ---
    if (action === "create") {
      const { name, airtable_base_id, airtable_table_id, clay_webhook_url_tracked, tags } = body;

      if (!name || !airtable_base_id) {
        return NextResponse.json({ error: "name and airtable_base_id required" }, { status: 400 });
      }

      const result = await db.execute({
        sql: `INSERT INTO sections (name, airtable_base_id, airtable_table_id, clay_webhook_url_tracked)
              VALUES (?, ?, ?, ?)`,
        args: [name, airtable_base_id, airtable_table_id || "tbl1BnpnsUBrBGeuy", clay_webhook_url_tracked || null],
      });

      const sectionId = Number(result.lastInsertRowid);

      if (tags && Array.isArray(tags)) {
        for (const tag of tags) {
          await db.execute({
            sql: "INSERT OR IGNORE INTO client_tags (tag, section_id) VALUES (?, ?)",
            args: [tag, sectionId],
          });
        }
      }

      return NextResponse.json({ id: sectionId, ok: true });
    }

    // --- UPDATE ---
    if (action === "update") {
      const { id, name, airtable_base_id, airtable_table_id, clay_webhook_url_tracked } = body;

      if (!id) {
        return NextResponse.json({ error: "id required" }, { status: 400 });
      }

      await db.execute({
        sql: `UPDATE sections SET
                name = COALESCE(?, name),
                airtable_base_id = COALESCE(?, airtable_base_id),
                airtable_table_id = COALESCE(?, airtable_table_id),
                clay_webhook_url_tracked = COALESCE(?, clay_webhook_url_tracked)
              WHERE id = ?`,
        args: [name || null, airtable_base_id || null, airtable_table_id || null, clay_webhook_url_tracked ?? null, id],
      });

      return NextResponse.json({ ok: true });
    }

    // --- DELETE ---
    if (action === "delete") {
      const { id } = body;

      if (!id) {
        return NextResponse.json({ error: "id required" }, { status: 400 });
      }

      await db.execute({ sql: "DELETE FROM client_tags WHERE section_id = ?", args: [id] });
      await db.execute({ sql: "DELETE FROM sections WHERE id = ?", args: [id] });

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Invalid action. Use create, update, or delete." }, { status: 400 });
  } catch (error) {
    console.error("[api/config/sections/mutate] POST failed:", error);
    return NextResponse.json({ error: "Failed to process request" }, { status: 500 });
  }
}
