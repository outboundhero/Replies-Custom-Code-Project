/**
 * GET /api/nurture/client/[tag][?fresh=1] — the Nurture client page (header,
 * panels, pipeline, target-campaign slots, batches, analytics), served from
 * the precomputed overview snapshot. ?fresh=1 rebuilds first (after an action
 * on the page, so it shows the change immediately).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getOverview, clientPayload } from "@/lib/nurture/overview-snapshot";

// Runs next to Turso (Mumbai): each read is one short hop, not a trip from the US.
export const preferredRegion = "bom1";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ tag: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const tag = decodeURIComponent((await params).tag || "").trim();
  if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });
  try {
    const p = clientPayload(await getOverview({ fresh: req.nextUrl.searchParams.get("fresh") === "1" }), tag);
    if (!p) return NextResponse.json({ error: `${tag} isn't an active client (churned or unknown).` }, { status: 404 });
    return NextResponse.json(p);
  } catch (e) {
    console.error("[api/nurture/client]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
