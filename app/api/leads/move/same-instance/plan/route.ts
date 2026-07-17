/**
 * POST /api/leads/move/same-instance/plan  { clientTag }
 *
 * Lists a client's campaigns across BOTH of its group instances — B2B (business)
 * and B2C (personal) — for the Same Instance tab's source + destination pickers.
 * Each campaign is tagged with its `instance` and `lane` ("b2b"/"b2c") so the UI
 * can group them B2B1 / B2C1 and route each source lead to the matching lane's
 * destination (personal→B2C, business→B2B), matched by ESP.
 *
 * Needs a group (to know the two instances). Admin-gated.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { listCampaigns, listCampaignsCached } from "@/lib/outboundhero-api";
import { detectCampaignEsp } from "@/lib/nurture/esp";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import { getClientInstances } from "@/lib/nurture/group-routing";
import { getServiceArea } from "@/lib/service-area";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const STATUSES = ["active", "paused", "completed", "stopped", "archived", "draft"];
const isNurtureName = (name: string) => /\[nurture\s*\d*\]|\(nurture\)/i.test(name);

export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { clientTag?: string; fresh?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const clientTag = String(body.clientTag || "").trim().toUpperCase();
  if (!clientTag) return NextResponse.json({ error: "clientTag is required" }, { status: 400 });

  // Manual "Refresh campaigns" bypasses the 60s Bison cache so a just-created /
  // still-processing campaign shows up once Bison returns it.
  const fetchCampaigns = body.fresh === true ? listCampaigns : listCampaignsCached;

  const instances = await getClientInstances(clientTag);
  if (!instances) {
    return NextResponse.json({ error: `no group mapping for ${clientTag} — assign a group in the group sheet so we know its B2B/B2C instances` }, { status: 400 });
  }
  const { group, b2b, b2c } = instances;
  // b2b and b2c are always distinct in the group map, but guard anyway.
  const lanes: Array<{ instance: string; lane: "b2b" | "b2c" }> = [{ instance: b2b, lane: "b2b" }];
  if (b2c !== b2b) lanes.push({ instance: b2c, lane: "b2c" });

  const exact = (name: string) => (extractTagFromCampaignName(name) || "").toUpperCase() === clientTag;
  try {
    const perLane = await Promise.all(lanes.map(async ({ instance, lane }) => {
      const all = await fetchCampaigns(instance, { search: clientTag, statuses: STATUSES });
      return all
        .filter((c) => exact(c.name) && detectCampaignEsp(c.name))
        .map((c) => ({
          id: c.id, name: c.name, status: c.status, esp: detectCampaignEsp(c.name)!,
          total_leads: c.total_leads ?? 0, isNurture: isNurtureName(c.name), instance, lane,
        }));
    }));
    const campaigns = perLane.flat().sort((a, b) => b.total_leads - a.total_leads);
    // The client's active service area (inclusion locations) so the UI can show
    // exactly what the service-area filter will match against. null = none set
    // (or too few parsed cities) → the filter moves everything.
    const area = await getServiceArea(clientTag);
    return NextResponse.json({
      clientTag, group, b2bInstance: b2b, b2cInstance: b2c, campaigns,
      serviceArea: area ? { raw: area.raw, cities: area.tokens } : null,
    });
  } catch (e) {
    return NextResponse.json({ error: `campaign fetch failed: ${(e as Error).message}` }, { status: 502 });
  }
}
