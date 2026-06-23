/**
 * POST /api/nurture/enable-sending  { clientTag, phase: "attach" | "activate" }
 *
 * Part of the "Confirm & enable sending" flow. Run in order by the UI:
 *   phase "attach"   → attach the client's tagged inboxes (split by ESP) to
 *                      each mapped campaign.
 *   (route ready leads — separate route-all loop)
 *   phase "activate" → resume (activate) the mapped campaigns so they send.
 *
 * Auth: admin (same as other nurture mutations).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { attachInboxesForClient, activateMappedCampaigns } from "@/lib/nurture/enable-sending";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // the inbox pool can be hundreds of paginated rows

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { clientTag?: string; phase?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const clientTag = (body.clientTag || "").trim().toUpperCase();
  if (!clientTag) return NextResponse.json({ error: "clientTag required" }, { status: 400 });
  const phase = body.phase === "activate" ? "activate" : "attach";

  try {
    const result = phase === "activate"
      ? await activateMappedCampaigns(clientTag)
      : await attachInboxesForClient(clientTag);
    return NextResponse.json({ phase, ...result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
