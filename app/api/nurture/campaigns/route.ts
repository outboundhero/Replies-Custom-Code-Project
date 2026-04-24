/**
 * GET /api/nurture/campaigns
 * Returns all OutboundHero campaigns whose name contains "[Nurture]".
 * Cached in-memory for 60 seconds to avoid hammering the upstream API.
 */

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { listCampaigns } from "@/lib/outboundhero-api";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";

interface CachedCampaigns {
  data: Array<{
    id: number;
    name: string;
    status: string;
    client_tag: string | null;
    total_leads?: number;
  }>;
  ts: number;
}

let cache: CachedCampaigns | null = null;
const CACHE_TTL_MS = 60 * 1000;

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const now = Date.now();
    if (cache && now - cache.ts < CACHE_TTL_MS) {
      return NextResponse.json({ campaigns: cache.data, cached: true });
    }

    const all = await listCampaigns({ nameContains: "[Nurture]" });
    const data = all.map((c) => ({
      id: c.id,
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
