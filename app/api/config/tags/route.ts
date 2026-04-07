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
      const { tags, section_id } = body;

      if (!tags || !section_id) {
        return NextResponse.json({ error: "tags and section_id required" }, { status: 400 });
      }

      const tagList = Array.isArray(tags) ? tags : [tags];
      const added: string[] = [];
      const failed: string[] = [];

      for (const tag of tagList) {
        try {
          await db.execute({
            sql: "INSERT INTO client_tags (tag, section_id) VALUES (?, ?)",
            args: [tag.trim(), section_id],
          });
          added.push(tag.trim());
        } catch {
          failed.push(tag.trim());
        }
      }

      return NextResponse.json({ added, failed });
    }

    // --- UPDATE — move tag to a different section ---
    if (action === "update") {
      const { tag, new_section_id } = body;

      if (!tag || !new_section_id) {
        return NextResponse.json({ error: "tag and new_section_id required" }, { status: 400 });
      }

      await db.execute({
        sql: "UPDATE client_tags SET section_id = ? WHERE tag = ?",
        args: [new_section_id, tag],
      });

      return NextResponse.json({ ok: true });
    }

    // --- DELETE — remove a tag ---
    if (action === "delete") {
      const { tag } = body;

      if (!tag) {
        return NextResponse.json({ error: "tag required" }, { status: 400 });
      }

      await db.execute({ sql: "DELETE FROM client_tags WHERE tag = ?", args: [tag] });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    console.error("[api/config/tags] POST failed:", error);
    return NextResponse.json({ error: "Failed to process tag request" }, { status: 500 });
  }
}
