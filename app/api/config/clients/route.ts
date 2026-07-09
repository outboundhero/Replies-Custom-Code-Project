import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { getChurnedClients } from "@/lib/churn";
import { getAllClientInstances } from "@/lib/nurture/group-routing";

// GET /api/config/clients — list all clients with section + config info.
//
// `bison_instance` is merged in from a separate query so the page keeps
// working even on a fresh deploy where the `client_instances` table
// doesn't exist yet. Clients without a mapping show as `null` (the UI
// renders that as the default instance).
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
        cc.auto_nurture_enabled,
        cc.auto_nurture_disabled,
        cc.updated_at
      FROM client_tags ct
      JOIN sections s ON ct.section_id = s.id
      LEFT JOIN client_config cc ON cc.client_tag = ct.tag
      ORDER BY s.name, ct.tag
    `);

    // Pull the client→instance mapping separately so a missing table
    // (pre-migration) doesn't blow up the whole client list.
    const instanceMap = new Map<string, string>();
    try {
      const instances = await db.execute("SELECT client_tag, instance_key FROM client_instances");
      for (const row of instances.rows) {
        instanceMap.set(row.client_tag as string, row.instance_key as string);
      }
    } catch {
      // Table doesn't exist yet — every client renders as "default" in the UI.
    }

    // Churn (tag → churn date) + group-native instances, for the Move Leads
    // "Returning" toggle and the Same Instance default instance suggestion.
    const churned = await getChurnedClients();
    const groupInstances = await getAllClientInstances();
    const rows = result.rows.map((r) => {
      const TAG = String(r.tag).toUpperCase();
      const inst = groupInstances.get(TAG);
      return {
        ...r,
        bison_instance: instanceMap.get(r.tag as string) ?? null,
        churned: churned.has(TAG),
        churnDate: churned.get(TAG) ?? null,
        group: inst?.group ?? null,
        b2b: inst?.b2b ?? null,
        b2c: inst?.b2c ?? null,
      };
    });
    return NextResponse.json(rows);
  } catch (error) {
    console.error("[api/config/clients] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch clients" }, { status: 500 });
  }
}
