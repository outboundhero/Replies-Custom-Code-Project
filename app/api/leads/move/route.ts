/**
 * POST /api/leads/move
 *
 * Cross-Instance Lead Mover — one bounded batch. Thin wrapper over
 * `moveCrossWindow` (lib/leads/move-window.ts), which holds the full
 * service-area → lane → per-lead-ESP → routeCandidates pipeline shared with the
 * server-side job runner. Copy-only, idempotent; the caller re-invokes with
 * `nextCursor` until `done`. Admin-gated. maxDuration 300.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { moveCrossWindow, type MoveCrossParams } from "@/lib/leads/move-window";
import type { Esp } from "@/lib/nurture/esp";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ESPS: Esp[] = ["google", "outlook", "segs"];

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: {
    clientTag?: string; sourceInstance?: string; sourceCampaignId?: number;
    sourceCampaignName?: string; targetInstance?: string; dest?: Partial<Record<Esp, number>>; cursor?: string | null;
    serviceAreaFilter?: boolean; runId?: string;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const clientTag = String(body.clientTag || "").trim().toUpperCase();
  const sourceInstance = String(body.sourceInstance || "").trim();
  const targetInstance = String(body.targetInstance || "").trim();
  const sourceCampaignId = Number(body.sourceCampaignId);

  const dest: Partial<Record<Esp, number>> = {};
  for (const e of ESPS) { const cid = Number(body.dest?.[e]); if (cid) dest[e] = cid; }

  if (!clientTag || !sourceInstance || !targetInstance || !sourceCampaignId) {
    return NextResponse.json({ error: "clientTag, sourceInstance, targetInstance, sourceCampaignId required" }, { status: 400 });
  }
  if (!ESPS.some((e) => dest[e])) {
    return NextResponse.json({ error: "no destination campaigns provided (need at least one of google/outlook/segs)" }, { status: 400 });
  }

  const params: MoveCrossParams = {
    runId: body.runId ? String(body.runId) : null,
    clientTag, sourceInstance, sourceCampaignId,
    sourceCampaignName: String(body.sourceCampaignName || ""),
    targetInstance, dest,
    serviceAreaFilter: body.serviceAreaFilter !== false, // default ON
    cursor: body.cursor ? String(body.cursor) : null,
  };

  const r = await moveCrossWindow(params);
  if (r.error) return NextResponse.json({ error: r.error }, { status: 502 });
  return NextResponse.json({
    ok: true, fetched: r.fetched, moved: r.moved,
    skippedArea: r.skippedArea, skippedLane: r.skippedLane, skippedNoDest: r.skippedNoDest,
    nextCursor: r.nextCursor, done: r.done,
  });
}
