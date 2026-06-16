/**
 * GET  /api/nurture/campaign-map?clientTag=TAG
 *   → { entries: [{ bison_instance, esp, campaign_id, campaign_name, lane }], confirmedAt }
 *
 * POST /api/nurture/campaign-map  { clientTag, entries: [...], confirm?: boolean }
 *   Replaces the client's target-campaign map and (when confirm) stamps
 *   client_config.nurture_map_confirmed_at — which is what gates all sending.
 *   confirm:false clears the confirmation (e.g. operator wants to re-pick).
 *
 * Auth: GET = any admin session; POST = admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin } from "@/lib/auth";
import db from "@/lib/db";
import { getCampaignMap, getMapConfirmedAt } from "@/lib/nurture/campaign-map";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  const clientTag = (req.nextUrl.searchParams.get("clientTag") || "").trim();
  if (!clientTag) return NextResponse.json({ error: "clientTag required" }, { status: 400 });
  const [entries, confirmedAt] = await Promise.all([getCampaignMap(clientTag), getMapConfirmedAt(clientTag)]);
  return NextResponse.json({ entries, confirmedAt });
}

interface Entry { bison_instance?: string; esp?: string; campaign_id?: number; campaign_name?: string; lane?: string }

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { clientTag?: string; entries?: Entry[]; confirm?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const clientTag = (body.clientTag || "").trim().toUpperCase();
  if (!clientTag) return NextResponse.json({ error: "clientTag required" }, { status: 400 });

  const entries = (body.entries || []).filter(
    (e) => e.bison_instance && e.esp && Number.isFinite(Number(e.campaign_id)) && Number(e.campaign_id) > 0,
  );

  // Replace the whole map for this client atomically, then set/clear confirm.
  const ops: Array<{ sql: string; args: (string | number | null)[] }> = [
    { sql: "DELETE FROM nurture_campaign_map WHERE UPPER(client_tag) = UPPER(?)", args: [clientTag] },
  ];
  for (const e of entries) {
    ops.push({
      sql: `INSERT INTO nurture_campaign_map (client_tag, bison_instance, esp, campaign_id, campaign_name, lane, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      args: [clientTag, String(e.bison_instance), String(e.esp), Number(e.campaign_id), e.campaign_name ?? null, e.lane ?? null],
    });
  }
  ops.push({ sql: "INSERT OR IGNORE INTO client_config (client_tag) VALUES (?)", args: [clientTag] });
  if (body.confirm === false) {
    ops.push({ sql: "UPDATE client_config SET nurture_map_confirmed_at = NULL, updated_at = datetime('now') WHERE client_tag = ?", args: [clientTag] });
  } else {
    ops.push({ sql: "UPDATE client_config SET nurture_map_confirmed_at = datetime('now'), updated_at = datetime('now') WHERE client_tag = ?", args: [clientTag] });
  }
  await db.batch(ops, "write");

  const confirmedAt = await getMapConfirmedAt(clientTag);
  return NextResponse.json({ ok: true, saved: entries.length, confirmedAt });
}
