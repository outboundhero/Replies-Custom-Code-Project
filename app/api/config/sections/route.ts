import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";

// GET all sections with their tags
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const sections = await db.execute(
      "SELECT * FROM sections ORDER BY id"
    );
    const tags = await db.execute(
      "SELECT * FROM client_tags ORDER BY tag"
    );

    const tagsBySection = new Map<number, string[]>();
    for (const tag of tags.rows) {
      const sectionId = tag.section_id as number;
      if (!tagsBySection.has(sectionId)) tagsBySection.set(sectionId, []);
      tagsBySection.get(sectionId)!.push(tag.tag as string);
    }

    const result = sections.rows.map((s) => ({
      ...s,
      tags: tagsBySection.get(s.id as number) || [],
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error("[api/config/sections] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch sections" }, { status: 500 });
  }
}
