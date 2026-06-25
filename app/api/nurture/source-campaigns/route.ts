/**
 * GET /api/nurture/source-campaigns?clientTag=TAG
 *
 * The client's OUTBOUND (non-nurture) campaigns that can be used as a SOURCE for
 * the "route a campaign's leads into nurture" feature. Filtered to the client's
 * own ESP-named campaigns with leads — the ESP is read from the campaign name.
 * Fanned out across the client's B2B + B2C instances. 60s cache.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import db from "@/lib/db";
import { listCampaigns, getCampaignLeadCount } from "@/lib/outboundhero-api";
import { getClientInstances } from "@/lib/nurture/group-routing";
import { detectCampaignEsp, isCanonicalNurtureCampaign } from "@/lib/nurture/esp";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";

export const dynamic = "force-dynamic";

const cache = new Map<string, { ts: number; data: unknown }>();
const TTL = 60_000;

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  const TAG = (req.nextUrl.searchParams.get("clientTag") || "").trim().toUpperCase();
  if (!TAG) return NextResponse.json({ error: "clientTag required" }, { status: 400 });

  const hit = cache.get(TAG);
  if (hit && Date.now() - hit.ts < TTL) return NextResponse.json({ ...(hit.data as object), cached: true });

  const instances = await getClientInstances(TAG);
  if (!instances) return NextResponse.json({ campaigns: [], error: "no group mapping for client" });

  // How many leads we've already routed from each source campaign (Turso log).
  const routedByCampaign = new Map<number, number>();
  try {
    const r = await db.execute({ sql: "SELECT source_campaign_id, COUNT(*) n FROM nurture_source_routed WHERE UPPER(client_tag)=? GROUP BY source_campaign_id", args: [TAG] });
    for (const row of r.rows as unknown as Array<{ source_campaign_id: number; n: number }>) routedByCampaign.set(Number(row.source_campaign_id), Number(row.n));
  } catch { /* table may not exist yet */ }

  const instanceKeys = Array.from(new Set([instances.b2b, instances.b2c]));
  const lists = await Promise.all(
    instanceKeys.map(async (instance) => {
      try {
        const all = await listCampaigns(instance, { search: TAG });
        const matched = all.filter((c) =>
          (extractTagFromCampaignName(c.name) || "").toUpperCase() === TAG &&
          !isCanonicalNurtureCampaign(c.name) &&          // exclude nurture campaigns
          detectCampaignEsp(c.name) != null &&            // ESP must be readable from the name
          (c.total_leads ?? 0) > 0,
        );
        // The routable number is SEQUENCE-FINISHED (no-reply) leads, not total —
        // that's all the nurture flow pulls. Fetch it per campaign (cheap: 1 req).
        return await Promise.all(matched.map(async (c) => {
          const seq = await getCampaignLeadCount(instance, c.id, "sequence_finished");
          const routed = routedByCampaign.get(c.id) ?? 0;
          return {
            id: c.id,
            name: c.name,
            status: c.status,
            bison_instance: instance,
            esp: detectCampaignEsp(c.name),
            total_leads: c.total_leads ?? 0,
            seq_finished: seq,
            routed,                                   // already pushed to nurture from this campaign
            new_leads: Math.max(0, seq - routed),     // not-yet-routed sequence-finished
          };
        }));
      } catch {
        return [];
      }
    }),
  );

  // Most NEW (un-routed sequence-finished) leads first.
  const campaigns = lists.flat().sort((a, b) => b.new_leads - a.new_leads);
  const data = { campaigns };
  cache.set(TAG, { ts: Date.now(), data });
  return NextResponse.json({ ...data, cached: false });
}
