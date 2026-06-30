/**
 * POST /api/nurture/sync
 * Runs the sequence-finished sync from EmailBison/OutboundHero.
 *
 * Body { clientTag? }: when present (run from a client page), only that client's
 * source campaigns are scanned — across BOTH of its instances (b2b + b2c) — which
 * is far cheaper than the all-clients/all-instances sweep. Omitted → global sync.
 *
 * Restricted to admins.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { syncSequenceFinished, syncOneClient } from "@/lib/nurture/sync-sequence-finished";
import { getClientInstances } from "@/lib/nurture/group-routing";

// The sync fans out across all 4 Bison instances in parallel, each with a 270s
// internal budget ("leaves 30s headroom inside the 5-min route" — see
// INSTANCE_TIMEOUT_MS). Without this the route inherits the platform default and
// is killed long before the work finishes. Mirrors the cron twin
// /api/cron/nurture-sync-sequence, which already sets maxDuration = 300.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let clientTag: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.clientTag === "string" && body.clientTag.trim()) {
      clientTag = body.clientTag.trim().toUpperCase();
    }
  } catch { /* no body → global sync */ }

  // ── Client-scoped: stream live NDJSON progress (one line per event) ──
  // The UI reads this incrementally to show, per campaign, how many
  // sequence-finished leads were found and written to the queue (+ ESP split).
  if (clientTag) {
    const tag = clientTag;
    const inst = await getClientInstances(tag);
    if (!inst) {
      return NextResponse.json({ error: `no instance group found for ${tag}` }, { status: 400 });
    }
    const instances = [...new Set([inst.b2b, inst.b2c])];
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const emit = (obj: unknown) => {
          try { controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n")); } catch { /* closed */ }
        };
        emit({ type: "start", clientTag: tag, instances });
        try {
          const perInstance = await Promise.all(
            instances.map((i) =>
              syncOneClient(i, tag, {
                maxPagesPerCampaign: 100,
                onProgress: (e) => emit({ type: e.phase, ...e }),
              }),
            ),
          );
          const totals = perInstance.reduce(
            (a, r) => ({
              campaignsScanned: a.campaignsScanned + r.campaignsScanned,
              candidatesFound: a.candidatesFound + r.candidatesFound,
              upserted: a.upserted + r.upserted,
              errors: [...a.errors, ...r.errors],
            }),
            { campaignsScanned: 0, candidatesFound: 0, upserted: 0, errors: [] as string[] },
          );
          emit({ type: "done", clientTag: tag, instances, ...totals });
        } catch (err) {
          emit({ type: "error", error: (err as Error).message });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // ── Global sync (no clientTag): unchanged JSON response ──
  try {
    const result = await syncSequenceFinished();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[api/nurture/sync] POST failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
