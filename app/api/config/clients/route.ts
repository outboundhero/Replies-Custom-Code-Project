import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";

// GET /api/config/clients — list all clients with section + config info
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
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
        cc.cc_name_5, cc.cc_email_5,
        cc.cc_name_6, cc.cc_email_6,
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
  } catch (error) {
    console.error("[api/config/clients] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch clients" }, { status: 500 });
  }
}
