/**
 * POST /api/leads/move/same-instance/plan  { clientTag, instance }
 *
 * Lists a client's campaigns in ONE Bison instance for the Same Instance tab's
 * source + destination pickers. Returns every exact-tag, ESP-detectable campaign
 * (all statuses, outreach AND nurture) with its ESP, status and lead count — the
 * operator picks which are sources and which are destinations.
 *
 * Not group-restricted (a returning client's campaigns may live in an old
 * instance), so it lists whatever exists for the tag in the chosen instance.
 *
 * Admin-gated.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { listCampaigns } from "@/lib/outboundhero-api";
import { detectCampaignEsp } from "@/lib/nurture/esp";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import { getClientInstances } from "@/lib/nurture/group-routing";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const STATUSES = ["active", "paused", "completed", "stopped", "archived", "draft"];
const isNurtureName = (name: string) => /\[nurture\s*\d*\]|\(nurture\)/i.test(name);

export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { clientTag?: string; instance?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const clientTag = String(body.clientTag || "").trim().toUpperCase();
  const instance = String(body.instance || "").trim();
  if (!clientTag || !instance) {
    return NextResponse.json({ error: "clientTag and instance are required" }, { status: 400 });
  }

  const nativeInstances = await getClientInstances(clientTag)
    .then((i) => (i ? [...new Set([i.b2b, i.b2c])] : []))
    .catch(() => [] as string[]);

  let all;
  try {
    all = await listCampaigns(instance, { search: clientTag, statuses: STATUSES });
  } catch (e) {
    return NextResponse.json({ error: `campaign fetch failed: ${(e as Error).message}` }, { status: 502 });
  }

  const exact = (name: string) => (extractTagFromCampaignName(name) || "").toUpperCase() === clientTag;
  const campaigns = all
    .filter((c) => exact(c.name) && detectCampaignEsp(c.name))
    .map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      esp: detectCampaignEsp(c.name)!,
      total_leads: c.total_leads ?? 0,
      isNurture: isNurtureName(c.name),
    }))
    .sort((a, b) => b.total_leads - a.total_leads);

  return NextResponse.json({ clientTag, instance, campaigns, nativeInstances });
}
