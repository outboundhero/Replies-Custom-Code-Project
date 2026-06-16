/**
 * POST /api/nurture/route-all  { clientTag, cap? }
 *
 * On-demand "Route all ready" for ONE client — runs the same server-side
 * auto-route engine the cron uses (runAutoPushForClient), but with a larger
 * per-call cap. It processes ONE bounded batch per request (so the serverless
 * function never times out) and returns how many it scanned/attached; the UI
 * loops this endpoint until `scanned === 0`, so the operator can route the
 * client's ENTIRE ready pool (not just the rows rendered in the table) without
 * hand-selecting leads.
 *
 * Only ESP-resolved, eligible (past 45-day cooldown), safe leads are routed —
 * each to its canonical Google/Outlook/SEGs nurture campaign. Leads whose ESP
 * isn't confirmed yet are held back (avoids misrouting) and become routable as
 * the ESP backfill fills them in.
 *
 * Auth: admin (same as other nurture mutations).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { runAutoPushForClient } from "@/lib/nurture/auto-push";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_CAP = 800; // per-call ceiling — keeps one request well under maxDuration

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { clientTag?: string; cap?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const clientTag = (body.clientTag || "").trim().toUpperCase();
  if (!clientTag) return NextResponse.json({ error: "clientTag required" }, { status: 400 });
  const cap = Math.min(MAX_CAP, Math.max(1, Number(body.cap) || MAX_CAP));

  try {
    const result = await runAutoPushForClient(clientTag, { cap });
    // done when this batch found nothing left to route.
    return NextResponse.json({ ...result, batchCap: cap, done: result.scanned === 0 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
