/**
 * POST /api/nurture/expand-now  { clientTag, dryRun? }
 *
 * On-demand trigger for the campaign-expansion evaluator on ONE client — lets
 * an operator preview (dryRun) or run an expansion without waiting for the
 * daily cron. dryRun=true reports which trios WOULD expand (and refreshes the
 * health snapshot) without creating any campaigns.
 *
 * Auth: admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { expandCampaignsForClient } from "@/lib/nurture/campaign-expansion";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  let body: { clientTag?: string; dryRun?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const clientTag = (body.clientTag || "").trim();
  if (!clientTag) return NextResponse.json({ error: "clientTag required" }, { status: 400 });
  try {
    // Safe by default: preview (dry-run) unless the caller explicitly sends dryRun:false.
    const result = await expandCampaignsForClient(clientTag, { dryRun: body.dryRun !== false });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
