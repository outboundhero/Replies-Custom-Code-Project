import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { getChurnedClients } from "@/lib/churn";
import { getAllClientInstances } from "@/lib/nurture/group-routing";
import { withCache, nsVersion } from "@/lib/server-cache";

const TTL = 60_000;

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
    const rows = await withCache(`config:clients:v${nsVersion("config")}`, TTL, async () => {
    // All four reads are independent → run them concurrently (Turso is remote,
    // so 4 sequential awaits was ~4 round trips of latency).
    const instancesPromise = db
      .execute("SELECT client_tag, instance_key FROM client_instances")
      .then((r) => {
        const m = new Map<string, string>();
        for (const row of r.rows) m.set(row.client_tag as string, row.instance_key as string);
        return m;
      })
      .catch(() => new Map<string, string>()); // table may not exist pre-migration

    const [result, instanceMap, churned, groupInstances] = await Promise.all([
      db.execute(`
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
    `),
      instancesPromise,
      getChurnedClients(),
      getAllClientInstances(),
    ]);

    return result.rows.map((r) => {
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
    });
    return NextResponse.json(rows);
  } catch (error) {
    console.error("[api/config/clients] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch clients" }, { status: 500 });
  }
}
