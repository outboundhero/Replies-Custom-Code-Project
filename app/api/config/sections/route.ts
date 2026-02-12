import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";

// GET all sections with their tags
export async function GET() {
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
}

// POST — create new section
export async function POST(req: NextRequest) {
  const { name, airtable_base_id, airtable_table_id, clay_webhook_url_tracked, tags } = await req.json();

  if (!name || !airtable_base_id) {
    return NextResponse.json({ error: "name and airtable_base_id required" }, { status: 400 });
  }

  const result = await db.execute({
    sql: `INSERT INTO sections (name, airtable_base_id, airtable_table_id, clay_webhook_url_tracked)
          VALUES (?, ?, ?, ?)`,
    args: [name, airtable_base_id, airtable_table_id || "tbl1BnpnsUBrBGeuy", clay_webhook_url_tracked || null],
  });

  const sectionId = Number(result.lastInsertRowid);

  // Add tags if provided
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

// PUT — update section
export async function PUT(req: NextRequest) {
  const { id, name, airtable_base_id, airtable_table_id, clay_webhook_url_tracked } = await req.json();

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

// DELETE — delete section
export async function DELETE(req: NextRequest) {
  const { id } = await req.json();

  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  await db.execute({ sql: "DELETE FROM client_tags WHERE section_id = ?", args: [id] });
  await db.execute({ sql: "DELETE FROM sections WHERE id = ?", args: [id] });

  return NextResponse.json({ ok: true });
}
