/**
 * POST /api/leads/move/plan
 *
 * Batch planner for the Lead Mover. Given a From instance, a To instance, and a
 * set of client tags, returns per client: the source campaigns (with lead
 * counts + ESP), and the auto-matched destination campaign per ESP in the To
 * instance (Google→Google, etc.), plus which ESPs have no destination.
 *
 * Read-only (no leads move here). Admin-gated.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { listCampaigns } from "@/lib/outboundhero-api";
import { detectCampaignEsp, type Esp } from "@/lib/nurture/esp";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const STATUSES = ["active", "paused", "completed", "stopped", "archived", "draft"];
const ESPS: Esp[] = ["google", "outlook", "segs"];
// Prefer active > draft > paused > everything else when auto-picking a destination.
const rankStatus = (s: string) => (s === "active" ? 0 : s === "draft" ? 1 : s === "paused" ? 2 : 3);
// Never move leads INTO a nurture campaign — matches "[Nurture]" and legacy
// "(Nurture)" markers. Destinations are always the plain outreach campaigns.
const isNurtureName = (name: string) => /\[nurture\]|\(nurture\)/i.test(name);

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await fn(items[idx]); } catch { out[idx] = null as unknown as R; }
      }
    }),
  );
  return out;
}

export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { sourceInstance?: string; targetInstance?: string; clientTags?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const sourceInstance = String(body.sourceInstance || "").trim();
  const targetInstance = String(body.targetInstance || "").trim();
  const tags = Array.isArray(body.clientTags)
    ? [...new Set(body.clientTags.map((t) => String(t).trim().toUpperCase()).filter(Boolean))]
    : [];
  if (!sourceInstance || !targetInstance) {
    return NextResponse.json({ error: "sourceInstance and targetInstance are required" }, { status: 400 });
  }
  if (!tags.length) return NextResponse.json({ sourceInstance, targetInstance, clients: [] });

  const clients = await pool(tags, 6, async (tag) => {
    const [srcAll, tgtAll] = await Promise.all([
      listCampaigns(sourceInstance, { search: tag, statuses: STATUSES }),
      listCampaigns(targetInstance, { search: tag, statuses: STATUSES }),
    ]);
    const exact = (name: string) => (extractTagFromCampaignName(name) || "").toUpperCase() === tag;

    const sourceCampaigns = srcAll
      .filter((c) => exact(c.name) && detectCampaignEsp(c.name) && (c.total_leads ?? 0) > 0)
      .map((c) => ({ id: c.id, name: c.name, status: c.status, esp: detectCampaignEsp(c.name)!, total_leads: c.total_leads ?? 0 }))
      .sort((a, b) => b.total_leads - a.total_leads);

    // Auto-match one destination per ESP in the target instance — EXCLUDING
    // nurture campaigns (leads must never be moved into a [Nurture] campaign).
    const match: Partial<Record<Esp, { campaignId: number; name: string; status: string }>> = {};
    for (const esp of ESPS) {
      const cands = tgtAll
        .filter((c) => exact(c.name) && !isNurtureName(c.name) && detectCampaignEsp(c.name) === esp)
        .sort((a, b) => rankStatus(a.status) - rankStatus(b.status) || (b.total_leads ?? 0) - (a.total_leads ?? 0) || a.id - b.id);
      if (cands.length) match[esp] = { campaignId: cands[0].id, name: cands[0].name, status: cands[0].status };
    }

    // All destination options per ESP (for the override dropdown), restricted to
    // this client's own NON-nurture tagged campaigns in the target instance.
    const targetOptions = tgtAll
      .filter((c) => exact(c.name) && !isNurtureName(c.name) && detectCampaignEsp(c.name))
      .map((c) => ({ id: c.id, name: c.name, status: c.status, esp: detectCampaignEsp(c.name)! }));

    const sourceEsps = [...new Set(sourceCampaigns.map((c) => c.esp))];
    const unmatchedEsps = sourceEsps.filter((e) => !match[e]);
    const totalLeads = sourceCampaigns.reduce((s, c) => s + c.total_leads, 0);
    const targetTagCampaigns = targetOptions.length; // exact-tag campaigns of any ESP in the To instance

    // Clean, single-word status the UI renders as a colored badge:
    //  empty   — no leads to move in the From instance (nothing to do)
    //  blocked — has leads, but the To instance has NO campaign for this tag at all
    //  partial — some source ESPs match a destination, but ≥1 ESP has no campaign
    //  ready   — every source ESP has a matching destination campaign
    let status: "ready" | "partial" | "blocked" | "empty";
    if (totalLeads === 0 || sourceEsps.length === 0) status = "empty";
    else if (unmatchedEsps.length === sourceEsps.length) status = "blocked";
    else if (unmatchedEsps.length > 0) status = "partial";
    else status = "ready";

    return { tag, status, sourceCampaigns, match, targetOptions, sourceEsps, unmatchedEsps, totalLeads, targetTagCampaigns };
  });

  return NextResponse.json({ sourceInstance, targetInstance, clients: clients.filter(Boolean) });
}
