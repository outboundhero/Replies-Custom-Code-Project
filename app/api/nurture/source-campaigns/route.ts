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
import { listCampaigns } from "@/lib/outboundhero-api";
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

  const instanceKeys = Array.from(new Set([instances.b2b, instances.b2c]));
  const lists = await Promise.all(
    instanceKeys.map(async (instance) => {
      try {
        const all = await listCampaigns(instance, { search: TAG });
        return all
          .filter((c) =>
            (extractTagFromCampaignName(c.name) || "").toUpperCase() === TAG &&
            !isCanonicalNurtureCampaign(c.name) &&          // exclude nurture campaigns
            detectCampaignEsp(c.name) != null &&            // ESP must be readable from the name
            (c.total_leads ?? 0) > 0,
          )
          .map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            bison_instance: instance,
            esp: detectCampaignEsp(c.name),
            total_leads: c.total_leads ?? 0,
          }));
      } catch {
        return [];
      }
    }),
  );

  // Most leads first.
  const campaigns = lists.flat().sort((a, b) => b.total_leads - a.total_leads);
  const data = { campaigns };
  cache.set(TAG, { ts: Date.now(), data });
  return NextResponse.json({ ...data, cached: false });
}
