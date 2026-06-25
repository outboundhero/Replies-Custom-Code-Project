/**
 * GET /api/nurture/campaign-live-counts?clientTag=TAG
 *
 * Live lead counts for a client's MAPPED nurture campaigns, fetched straight
 * from Bison (not the 10-min nurture_campaigns_cache). The pipeline uses these
 * so the per-campaign numbers match reality — Bison fills active campaigns by
 * caching attached leads and syncing them in over time, so the cached snapshot
 * lags during a big push. Only the ≤6 mapped campaigns are fetched, 60s cache.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getCampaignMap } from "@/lib/nurture/campaign-map";
import { getCampaignDetails } from "@/lib/outboundhero-api";

export const dynamic = "force-dynamic";

const cache = new Map<string, { ts: number; data: unknown }>();
const TTL = 60_000;

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  const clientTag = (req.nextUrl.searchParams.get("clientTag") || "").trim().toUpperCase();
  if (!clientTag) return NextResponse.json({ error: "clientTag required" }, { status: 400 });

  const hit = cache.get(clientTag);
  if (hit && Date.now() - hit.ts < TTL) return NextResponse.json({ ...(hit.data as object), cached: true });

  const map = await getCampaignMap(clientTag);
  const counts = await Promise.all(
    map.map(async (m) => {
      try {
        const d = await getCampaignDetails(m.bison_instance, m.campaign_id);
        return { instance: m.bison_instance, esp: m.esp, campaignId: m.campaign_id, name: d?.name ?? m.campaign_name, totalLeads: d?.total_leads ?? null, status: d?.status ?? null };
      } catch {
        return { instance: m.bison_instance, esp: m.esp, campaignId: m.campaign_id, name: m.campaign_name, totalLeads: null, status: null };
      }
    }),
  );
  const total = counts.reduce((s, c) => s + (c.totalLeads ?? 0), 0);
  const data = { counts, total };
  cache.set(clientTag, { ts: Date.now(), data });
  return NextResponse.json({ ...data, cached: false });
}
