import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";

// POST — update untracked config (action: "update")
export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const body = await req.json();
    const { action, airtable_base_id, airtable_table_id, clay_webhook_url } = body;

    if (action && action !== "update") {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

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
    console.error("[api/config/untracked/mutate] POST failed:", error);
    return NextResponse.json({ error: "Failed to update untracked config" }, { status: 500 });
  }
}
