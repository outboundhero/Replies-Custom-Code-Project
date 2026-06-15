/**
 * GET /api/nurture/campaigns
 * Returns all OutboundHero campaigns whose name contains "[Nurture]".
 *
 * Cached in-memory for 10 minutes — the campaign list barely changes,
 * and the upstream OB API pagination (parallelised in listCampaigns)
 * still takes ~1–2 s on a cold call. 10 min keeps the per-client
 * detail page snappy when navigating between clients.
 *
 * Multi-instance: with `?clientTag=…` the route only hits that client's
 * instance (one fetch). Without it, it fans out across all 4 instances
 * with Promise.allSettled so one bad instance doesn't kill the response.
 * Cache is keyed per-instance so a scoped fetch warms only its own slot.
 *
 * Pass ?fresh=1 to bypass the cache (used by the Refresh button on the
 * hub once we want).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { listCampaigns } from "@/lib/outboundhero-api";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import { BISON_INSTANCES, resolveInstanceForClient, type BisonInstanceKey } from "@/lib/bison-instances";
import db from "@/lib/db";

/**
 * Fast path: read the shared nurture_campaigns_cache table (refreshed every
 * ~10 min by /api/cron/refresh-nurture-campaigns). Sub-100ms and consistent
 * across serverless instances — vs the live Bison pagination which is 30-60s
 * cold and was the "From/To campaigns won't load" problem. Returns null when
 * the table is empty/missing so callers fall back to the live fetch.
 */
async function fromCache(clientTag: string | null): Promise<CampaignRow[] | null> {
  try {
    const sql = clientTag
      ? "SELECT id, uuid, name, status, client_tag, total_leads, bison_instance FROM nurture_campaigns_cache WHERE UPPER(client_tag) = UPPER(?)"
      : "SELECT id, uuid, name, status, client_tag, total_leads, bison_instance FROM nurture_campaigns_cache";
    const res = clientTag ? await db.execute({ sql, args: [clientTag] }) : await db.execute(sql);
    if (!res.rows || res.rows.length === 0) return null;
    return res.rows.map((r) => ({
      id: Number(r.id),
      uuid: (r.uuid as string) ?? null,
      name: r.name as string,
      status: r.status as string,
      client_tag: (r.client_tag as string) ?? null,
      total_leads: Number(r.total_leads) || 0,
      bison_instance: r.bison_instance as BisonInstanceKey,
    }));
  } catch {
    return null; // table not created yet → live fallback
  }
}

interface CampaignRow {
  id: number;
  uuid: string | null;
  name: string;
  status: string;
  client_tag: string | null;
  total_leads?: number;
  bison_instance: BisonInstanceKey;
}

const cache = new Map<BisonInstanceKey, { data: CampaignRow[]; ts: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function loadInstance(instanceKey: BisonInstanceKey, fresh: boolean): Promise<CampaignRow[]> {
  const now = Date.now();
  const cached = cache.get(instanceKey);
  if (!fresh && cached && now - cached.ts < CACHE_TTL_MS) return cached.data;

  // Match any campaign whose name has the word "nurture" anywhere — case
  // insensitive, whole word so "Nurturing" doesn't accidentally match.
  // Covers all wrapper styles seen in the wild: [Nurture], (Nurture), and
  // bare Nurture. We over-fetch then filter client-side because the
  // upstream API doesn't support regex matching.
  const all = await listCampaigns(instanceKey);
  const filtered = all
    .filter((c) => /\bnurture\b/i.test(c.name || ""))
    .map<CampaignRow>((c) => ({
      id: c.id,
      uuid: c.uuid ?? null,
      name: c.name,
      status: c.status,
      client_tag: extractTagFromCampaignName(c.name) || null,
      total_leads: c.total_leads,
      bison_instance: instanceKey,
    }));

  cache.set(instanceKey, { data: filtered, ts: now });
  return filtered;
}

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  const clientTag = req.nextUrl.searchParams.get("clientTag");

  try {
    // Fastest path: the shared snapshot table (instant, cross-instance).
    // Skipped on ?fresh=1 (force a live Bison pull).
    if (!fresh) {
      const cached = await fromCache(clientTag);
      if (cached) return NextResponse.json({ campaigns: cached, cached: true, source: "table" });
    }

    // Scoped fetch — one instance only. Fast path for the per-client
    // detail page since it only ever cares about its own client.
    if (clientTag) {
      const instanceKey = await resolveInstanceForClient(clientTag);
      const data = await loadInstance(instanceKey, fresh);
      return NextResponse.json({
        campaigns: data,
        cached: !fresh && cache.has(instanceKey),
        instance: instanceKey,
      });
    }

    // Fan-out fetch — every instance in parallel. Used by the hub when
    // it needs the universe of nurture campaigns.
    const results = await Promise.allSettled(
      BISON_INSTANCES.map((i) => loadInstance(i.key, fresh)),
    );
    const data: CampaignRow[] = [];
    const failures: Array<{ instance: string; error: string }> = [];
    results.forEach((r, idx) => {
      const key = BISON_INSTANCES[idx].key;
      if (r.status === "fulfilled") data.push(...r.value);
      else failures.push({ instance: key, error: (r.reason as Error)?.message || "unknown" });
    });

    return NextResponse.json({
      campaigns: data,
      cached: !fresh,
      failures: failures.length ? failures : undefined,
    });
  } catch (error) {
    console.error("[api/nurture/campaigns] GET failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
