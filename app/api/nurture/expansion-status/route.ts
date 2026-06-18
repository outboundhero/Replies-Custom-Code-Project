/**
 * GET /api/nurture/expansion-status
 *
 * Fast, Turso-only feed for the Campaigns monitoring tab. Reads the health
 * snapshot (nurture_routing_health) + expansion audit (nurture_campaign_expansions)
 * the expansion cron writes — never touches Bison on load. 60s cache.
 *
 * Returns per-routing (client × instance) trio health with completion %, lead
 * counts, batch, and a status (building / ready / expanded), plus a recent-
 * expansions list and summary stats.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import db from "@/lib/db";
import { getAllClientInstances } from "@/lib/nurture/group-routing";
import { getChurnedTags } from "@/lib/churn";
import { CONTACTED_MIN, COMBINED_LEADS_MIN } from "@/lib/nurture/campaign-expansion";
import type { Esp } from "@/lib/nurture/esp";

export const dynamic = "force-dynamic";

const ESPS: Esp[] = ["google", "outlook", "segs"];
type Cell = { campaignId: number | null; name: string | null; completion: number; total: number; status: string };
interface Routing {
  clientTag: string; group: number | null; instance: string; lane: "b2b" | "b2c" | null;
  esps: Record<Esp, Cell | null>; combinedLeads: number; allAbove50: boolean; readyToExpand: boolean;
  batch: number; checkedAt: string | null;
}

let cache: { ts: number; data: unknown } | null = null;
const TTL = 60_000;

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  if (!fresh && cache && Date.now() - cache.ts < TTL) return NextResponse.json({ ...(cache.data as object), cached: true });

  const [healthRes, expRes, instances, churned] = await Promise.all([
    db.execute("SELECT client_tag, bison_instance, esp, campaign_id, campaign_name, completion_percentage, total_leads, status, batch, checked_at FROM nurture_routing_health"),
    db.execute("SELECT client_tag, bison_instance, esp, batch, old_campaign_id, new_campaign_id, created_at FROM nurture_campaign_expansions ORDER BY created_at DESC LIMIT 60"),
    getAllClientInstances(),
    getChurnedTags(),
  ]);

  // Group health rows into routings keyed by (client, instance).
  const map = new Map<string, Routing>();
  for (const r of healthRes.rows as unknown as Array<{ client_tag: string; bison_instance: string; esp: Esp; campaign_id: number; campaign_name: string; completion_percentage: number; total_leads: number; status: string; batch: number; checked_at: string }>) {
    const TAG = String(r.client_tag).toUpperCase();
    if (churned.has(TAG)) continue;
    const key = `${TAG}::${r.bison_instance}`;
    if (!map.has(key)) {
      const inst = instances.get(TAG);
      const lane = inst ? (r.bison_instance === inst.b2b ? "b2b" : r.bison_instance === inst.b2c ? "b2c" : null) : null;
      map.set(key, { clientTag: TAG, group: inst?.group ?? null, instance: r.bison_instance, lane, esps: { google: null, outlook: null, segs: null }, combinedLeads: 0, allAbove50: false, readyToExpand: false, batch: 1, checkedAt: null });
    }
    const routing = map.get(key)!;
    routing.esps[r.esp] = { campaignId: r.campaign_id ?? null, name: r.campaign_name ?? null, completion: Number(r.completion_percentage) || 0, total: Number(r.total_leads) || 0, status: String(r.status || "") };
    routing.batch = Math.max(routing.batch, Number(r.batch) || 1);
    if (r.checked_at && (!routing.checkedAt || String(r.checked_at) > routing.checkedAt)) routing.checkedAt = String(r.checked_at);
  }

  const routings = [...map.values()].map((r) => {
    const cells = ESPS.map((e) => r.esps[e]).filter(Boolean) as Cell[];
    r.combinedLeads = cells.reduce((s, c) => s + c.total, 0);
    r.allAbove50 = cells.length === 3 && cells.every((c) => c.completion >= CONTACTED_MIN);
    r.readyToExpand = r.allAbove50 && r.combinedLeads > COMBINED_LEADS_MIN;
    return r;
  });

  // Sort: ready-to-expand first, then closest to threshold (by min completion across the trio).
  const minCompletion = (r: Routing) => Math.min(...ESPS.map((e) => r.esps[e]?.completion ?? 0));
  routings.sort((a, b) => (Number(b.readyToExpand) - Number(a.readyToExpand)) || (minCompletion(b) - minCompletion(a)) || a.clientTag.localeCompare(b.clientTag));

  const recentExpansions = (expRes.rows as unknown as Array<{ client_tag: string; bison_instance: string; esp: string; batch: number; created_at: string }>)
    .map((x) => ({ clientTag: String(x.client_tag).toUpperCase(), instance: x.bison_instance, esp: x.esp, batch: Number(x.batch), createdAt: x.created_at }));

  const data = {
    routings,
    recentExpansions,
    stats: {
      routingsWatched: routings.length,
      readyToExpand: routings.filter((r) => r.readyToExpand).length,
      totalClones: expRes.rows.length,
      largestCombined: routings.reduce((m, r) => Math.max(m, r.combinedLeads), 0),
    },
    thresholds: { completion: CONTACTED_MIN, combinedLeads: COMBINED_LEADS_MIN },
    cached: false,
  };
  cache = { ts: Date.now(), data };
  return NextResponse.json(data);
}
