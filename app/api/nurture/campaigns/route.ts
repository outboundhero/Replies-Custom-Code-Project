/**
 * GET /api/nurture/campaigns
 * Returns all OutboundHero campaigns whose name contains "[Nurture]".
 *
 * Cached in-memory for 10 minutes — the campaign list barely changes,
 * and the upstream OB API pagination (parallelised in listCampaigns)
 * still takes ~1–2 s on a cold call. 10 min keeps the per-client
 * detail page snappy when navigating between clients.
 *
 * Pass ?fresh=1 to bypass the cache (used by the Refresh button on the
 * hub once we want).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { listCampaigns } from "@/lib/outboundhero-api";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";

interface CachedCampaigns {
  data: Array<{
    id: number;
    uuid: string | null;
    name: string;
    status: string;
    client_tag: string | null;
    total_leads?: number;
  }>;
  ts: number;
}

let cache: CachedCampaigns | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const fresh = req.nextUrl.searchParams.get("fresh") === "1";

  try {
    const now = Date.now();
    if (!fresh && cache && now - cache.ts < CACHE_TTL_MS) {
      return NextResponse.json({ campaigns: cache.data, cached: true });
    }

    // Match any campaign whose name has the word "nurture" anywhere — case
    // insensitive, whole word so "Nurturing" doesn't accidentally match.
    // Covers all wrapper styles seen in the wild: [Nurture], (Nurture), and
    // bare Nurture. We over-fetch then filter client-side because the
    // upstream API doesn't support regex matching.
    const allCampaigns = await listCampaigns();
    const all = allCampaigns.filter((c) => /\bnurture\b/i.test(c.name || ""));
    const data = all.map((c) => ({
      id: c.id,
      uuid: c.uuid ?? null,
      name: c.name,
      status: c.status,
      client_tag: extractTagFromCampaignName(c.name) || null,
      total_leads: c.total_leads,
    }));

    cache = { data, ts: now };
    return NextResponse.json({ campaigns: data, cached: false });
  } catch (error) {
    console.error("[api/nurture/campaigns] GET failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
