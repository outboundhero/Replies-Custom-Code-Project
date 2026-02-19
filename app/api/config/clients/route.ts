import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";

// GET /api/config/clients — list all clients with section + config info
export async function GET() {
  const result = await db.execute(`
    SELECT
      ct.id,
      ct.tag,
      ct.section_id,
      s.name AS section_name,
      s.airtable_base_id,
      s.clay_webhook_url_tracked,
      cc.id AS config_id,
      cc.cc_name_1, cc.cc_email_1,
      cc.cc_name_2, cc.cc_email_2,
      cc.cc_name_3, cc.cc_email_3,
      cc.cc_name_4, cc.cc_email_4,
      cc.bcc_name_1, cc.bcc_email_1,
      cc.bcc_name_2, cc.bcc_email_2,
      cc.reply_template,
      cc.updated_at
    FROM client_tags ct
    JOIN sections s ON ct.section_id = s.id
    LEFT JOIN client_config cc ON cc.client_tag = ct.tag
    ORDER BY s.name, ct.tag
  `);
  return NextResponse.json(result.rows);
}

// POST /api/config/clients — onboard new client (creates tag + empty config)
export async function POST(req: NextRequest) {
  const { tag, section_id } = await req.json();
  if (!tag || !section_id) {
    return NextResponse.json({ error: "tag and section_id required" }, { status: 400 });
  }

  // Insert into client_tags
  await db.execute({
    sql: "INSERT INTO client_tags (tag, section_id) VALUES (?, ?)",
    args: [tag.trim(), section_id],
  });

  // Create empty client_config row
  await db.execute({
    sql: "INSERT OR IGNORE INTO client_config (client_tag) VALUES (?)",
    args: [tag.trim()],
  });

  return NextResponse.json({ ok: true });
}

// PUT /api/config/clients — update client config (CC/BCC/reply template)
export async function PUT(req: NextRequest) {
  const {
    tag,
    cc_name_1, cc_email_1,
    cc_name_2, cc_email_2,
    cc_name_3, cc_email_3,
    cc_name_4, cc_email_4,
    bcc_name_1, bcc_email_1,
    bcc_name_2, bcc_email_2,
    reply_template,
  } = await req.json();

  if (!tag) {
    return NextResponse.json({ error: "tag required" }, { status: 400 });
  }

  await db.execute({
    sql: `INSERT INTO client_config
            (client_tag, cc_name_1, cc_email_1, cc_name_2, cc_email_2,
             cc_name_3, cc_email_3, cc_name_4, cc_email_4,
             bcc_name_1, bcc_email_1, bcc_name_2, bcc_email_2,
             reply_template, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(client_tag) DO UPDATE SET
            cc_name_1 = excluded.cc_name_1,
            cc_email_1 = excluded.cc_email_1,
            cc_name_2 = excluded.cc_name_2,
            cc_email_2 = excluded.cc_email_2,
            cc_name_3 = excluded.cc_name_3,
            cc_email_3 = excluded.cc_email_3,
            cc_name_4 = excluded.cc_name_4,
            cc_email_4 = excluded.cc_email_4,
            bcc_name_1 = excluded.bcc_name_1,
            bcc_email_1 = excluded.bcc_email_1,
            bcc_name_2 = excluded.bcc_name_2,
            bcc_email_2 = excluded.bcc_email_2,
            reply_template = excluded.reply_template,
            updated_at = CURRENT_TIMESTAMP`,
    args: [
      tag,
      cc_name_1 || null, cc_email_1 || null,
      cc_name_2 || null, cc_email_2 || null,
      cc_name_3 || null, cc_email_3 || null,
      cc_name_4 || null, cc_email_4 || null,
      bcc_name_1 || null, bcc_email_1 || null,
      bcc_name_2 || null, bcc_email_2 || null,
      reply_template || null,
    ],
  });

  return NextResponse.json({ ok: true });
}

// DELETE /api/config/clients — remove client tag (and config)
export async function DELETE(req: NextRequest) {
  const { tag } = await req.json();
  if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });

  await db.execute({ sql: "DELETE FROM client_tags WHERE tag = ?", args: [tag] });
  await db.execute({ sql: "DELETE FROM client_config WHERE client_tag = ?", args: [tag] });

  return NextResponse.json({ ok: true });
}
