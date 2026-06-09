/**
 * GET /api/config/clients/[tag]?secret=<CRON_SECRET>
 *
 * Returns full configuration for a single client tag: CC/BCC recipients,
 * reply template, section, Bison instance, last update timestamp.
 *
 * Auth: CRON_SECRET via query string or header (curl-friendly — same
 * pattern as the cron endpoints). Sensitive enough to gate on a shared
 * secret but not so sensitive that it needs a full JWT session.
 *
 * Example:
 *   curl "https://replies-custom-code-project.vercel.app/api/config/clients/JPC?secret=outboundhero2024"
 */
import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { DEFAULT_INSTANCE } from "@/lib/bison-instances";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ tag: string }> },
) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { tag: raw } = await params;
  const tag = raw.toUpperCase();
  if (!tag) {
    return NextResponse.json({ error: "tag required" }, { status: 400 });
  }

  // Pull client tag + section + config in one query (matches the list
  // endpoint's join). LEFT JOIN client_config so a tag without a config
  // row still returns — fields just come back as null.
  const result = await db.execute({
    sql: `SELECT
            ct.tag,
            ct.section_id,
            s.name AS section_name,
            s.airtable_base_id,
            cc.cc_name_1, cc.cc_email_1,
            cc.cc_name_2, cc.cc_email_2,
            cc.cc_name_3, cc.cc_email_3,
            cc.cc_name_4, cc.cc_email_4,
            cc.cc_name_5, cc.cc_email_5,
            cc.cc_name_6, cc.cc_email_6,
            cc.bcc_name_1, cc.bcc_email_1,
            cc.bcc_name_2, cc.bcc_email_2,
            cc.reply_template,
            cc.auto_nurture_enabled,
            cc.auto_nurture_enabled_at,
            cc.auto_nurture_last_run_at,
            cc.updated_at
          FROM client_tags ct
          JOIN sections s ON ct.section_id = s.id
          LEFT JOIN client_config cc ON cc.client_tag = ct.tag
          WHERE ct.tag = ?`,
    args: [tag],
  });

  if (result.rows.length === 0) {
    return NextResponse.json({ error: `Client tag "${tag}" not found` }, { status: 404 });
  }
  const row = result.rows[0] as Record<string, unknown>;

  // Pick up Bison instance mapping (no-row = default instance).
  let bisonInstance: string = DEFAULT_INSTANCE;
  try {
    const inst = await db.execute({
      sql: "SELECT instance_key FROM client_instances WHERE client_tag = ?",
      args: [tag],
    });
    if (inst.rows.length > 0) {
      bisonInstance = inst.rows[0].instance_key as string;
    }
  } catch { /* table may not exist on pre-migration deployments */ }

  // Build CC/BCC arrays out of the slot columns, dropping empty slots.
  const cc: Array<{ name: string; email: string }> = [];
  for (let i = 1; i <= 6; i++) {
    const email = row[`cc_email_${i}`] as string | null;
    if (email) cc.push({ name: (row[`cc_name_${i}`] as string | null) || "", email });
  }
  const bcc: Array<{ name: string; email: string }> = [];
  for (let i = 1; i <= 2; i++) {
    const email = row[`bcc_email_${i}`] as string | null;
    if (email) bcc.push({ name: (row[`bcc_name_${i}`] as string | null) || "", email });
  }

  return NextResponse.json({
    tag: row.tag,
    section: { id: row.section_id, name: row.section_name, airtable_base_id: row.airtable_base_id },
    bison_instance: bisonInstance,
    cc,
    bcc,
    reply_template: row.reply_template || null,
    auto_nurture: {
      enabled: Number(row.auto_nurture_enabled || 0) === 1,
      enabled_at: row.auto_nurture_enabled_at || null,
      last_run_at: row.auto_nurture_last_run_at || null,
    },
    updated_at: row.updated_at || null,
  });
}
