/**
 * POST /api/leads/move/same-instance
 *
 * Lane-aware mover for the Same Instance tab — one bounded batch. Thin wrapper
 * over `moveSameWindow` (lib/leads/move-window.ts), which holds the full
 * service-area → per-lead-ESP → lane-split → routeCandidates pipeline shared with
 * the server-side job runner. Copy-only, idempotent; caller re-invokes with
 * `nextCursor` until `done`. Admin-gated. maxDuration 300.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { moveSameWindow, type MoveSameParams } from "@/lib/leads/move-window";
import type { Esp } from "@/lib/nurture/esp";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ESPS: Esp[] = ["google", "outlook", "segs"];
type SameDest = { b2b: Partial<Record<Esp, number>>; b2c: Partial<Record<Esp, number>> };

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: {
    clientTag?: string; sourceInstance?: string; sourceCampaignId?: number; sourceCampaignName?: string;
    b2bInstance?: string; b2cInstance?: string; dest?: SameDest; cursor?: string | null;
    serviceAreaFilter?: boolean; runId?: string;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const clientTag = String(body.clientTag || "").trim().toUpperCase();
  const sourceInstance = String(body.sourceInstance || "").trim();
  const sourceCampaignId = Number(body.sourceCampaignId);
  const b2bInstance = String(body.b2bInstance || "").trim();
  const b2cInstance = String(body.b2cInstance || "").trim();
  const dest: SameDest = { b2b: body.dest?.b2b || {}, b2c: body.dest?.b2c || {} };

  if (!clientTag || !sourceInstance || !sourceCampaignId || !b2bInstance || !b2cInstance) {
    return NextResponse.json({ error: "clientTag, sourceInstance, sourceCampaignId, b2bInstance, b2cInstance required" }, { status: 400 });
  }
  if (!ESPS.some((e) => dest.b2b[e] || dest.b2c[e])) {
    return NextResponse.json({ error: "no destination campaigns selected" }, { status: 400 });
  }

  const params: MoveSameParams = {
    runId: body.runId ? String(body.runId) : null,
    clientTag, sourceInstance, sourceCampaignId,
    sourceCampaignName: String(body.sourceCampaignName || ""),
    b2bInstance, b2cInstance, dest,
    serviceAreaFilter: body.serviceAreaFilter !== false, // default ON
    cursor: body.cursor ? String(body.cursor) : null,
  };

  const r = await moveSameWindow(params);
  if (r.error) return NextResponse.json({ error: r.error }, { status: 502 });
  return NextResponse.json({ ok: true, fetched: r.fetched, movedByKey: r.movedByKey, skipped: r.skipped, skippedArea: r.skippedArea, nextCursor: r.nextCursor, done: r.done });
}
