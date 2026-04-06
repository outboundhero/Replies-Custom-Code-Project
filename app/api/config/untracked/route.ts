import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";

// GET untracked config
export async function GET() {
  try {
    const result = await db.execute("SELECT * FROM untracked_config WHERE id = 1");
    if (result.rows.length === 0) {
      return NextResponse.json(null);
    }
    return NextResponse.json(result.rows[0]);
  } catch (error) {
    console.error("[api/config/untracked] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch untracked config" }, { status: 500 });
  }
}

// PUT — update untracked config
export async function PUT(req: NextRequest) {
  try {
    const { airtable_base_id, airtable_table_id, clay_webhook_url } = await req.json();

    await db.execute({
      sql: `INSERT INTO untracked_config (id, airtable_base_id, airtable_table_id, clay_webhook_url)
            VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              airtable_base_id = COALESCE(excluded.airtable_base_id, airtable_base_id),
              airtable_table_id = COALESCE(excluded.airtable_table_id, airtable_table_id),
              clay_webhook_url = COALESCE(excluded.clay_webhook_url, clay_webhook_url)`,
      args: [
        airtable_base_id || "appqZiSdsbeBCuHEp",
        airtable_table_id || "tbl1BnpnsUBrBGeuy",
        clay_webhook_url || null,
      ],
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[api/config/untracked] PUT failed:", error);
    return NextResponse.json({ error: "Failed to update untracked config" }, { status: 500 });
  }
}
