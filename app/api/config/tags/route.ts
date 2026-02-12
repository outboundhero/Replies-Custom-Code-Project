import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";

// POST — add tag(s) to a section
export async function POST(req: NextRequest) {
  const { tags, section_id } = await req.json();

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

// PUT — move tag to a different section
export async function PUT(req: NextRequest) {
  const { tag, new_section_id } = await req.json();

  if (!tag || !new_section_id) {
    return NextResponse.json({ error: "tag and new_section_id required" }, { status: 400 });
  }

  await db.execute({
    sql: "UPDATE client_tags SET section_id = ? WHERE tag = ?",
    args: [new_section_id, tag],
  });

  return NextResponse.json({ ok: true });
}

// DELETE — remove a tag
export async function DELETE(req: NextRequest) {
  const { tag } = await req.json();

  if (!tag) {
    return NextResponse.json({ error: "tag required" }, { status: 400 });
  }

  await db.execute({ sql: "DELETE FROM client_tags WHERE tag = ?", args: [tag] });
  return NextResponse.json({ ok: true });
}
