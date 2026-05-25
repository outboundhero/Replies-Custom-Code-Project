/**
 * POST /api/clients/instance
 *
 * Admin-only. Assigns (or re-assigns) a client tag to a specific Bison
 * instance. After the update, the in-process cache for that tag is
 * invalidated so the change takes effect on the very next read.
 *
 * Body: { client_tag: string, instance_key: string }
 *
 * Effect on existing rows: NONE. Historical replies stay stamped with
 * whatever instance they came from — that's the right answer because
 * the original Bison IDs (sender_id, reply_id, campaign_id) are only
 * valid on the original instance. Only NEW replies for this client will
 * arrive stamped with the new instance.
 */

import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAdmin, getSession } from "@/lib/auth";
import { isValidInstance, invalidateInstanceCache } from "@/lib/bison-instances";

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const body = await req.json();
    const clientTag = (body.client_tag || "").trim();
    const instanceKey = (body.instance_key || "").trim();

    if (!clientTag) {
      return NextResponse.json({ error: "client_tag required" }, { status: 400 });
    }
    if (!isValidInstance(instanceKey)) {
      return NextResponse.json({ error: `Unknown instance_key: ${instanceKey}` }, { status: 400 });
    }

    const session = await getSession();
    const updatedBy = session?.email ?? "admin";

    await db.execute({
      sql: `INSERT INTO client_instances (client_tag, instance_key, updated_at, updated_by)
            VALUES (?, ?, CURRENT_TIMESTAMP, ?)
            ON CONFLICT(client_tag) DO UPDATE SET
              instance_key = excluded.instance_key,
              updated_at = CURRENT_TIMESTAMP,
              updated_by = excluded.updated_by`,
      args: [clientTag, instanceKey, updatedBy],
    });

    invalidateInstanceCache(clientTag);

    return NextResponse.json({ ok: true, client_tag: clientTag, instance_key: instanceKey });
  } catch (error) {
    console.error("[api/clients/instance] POST failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
