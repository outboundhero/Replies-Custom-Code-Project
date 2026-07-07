/**
 * POST /api/leads/move
 *
 * Lead Mover — one bounded batch: cursor-sweep a window of a SOURCE campaign's
 * leads and copy them into a TARGET campaign (same or another Bison instance),
 * reusing the nurture routing core (routeCandidates: same-instance attach, or
 * cross-instance create+attach). The caller re-invokes with the returned
 * `nextCursor` until `done`. Copy-only — the source campaign is NOT modified
 * (operator pauses it).
 *
 * Cursor pagination (not page pagination) is used because Bison hard-caps page
 * pagination at 1000 pages (= 15,000 leads/campaign, 15 rows/page locked). Cursor
 * has no cap, so this reaches EVERY lead in campaigns larger than 15k. Each call
 * sweeps up to WINDOW leads (or ~time budget) then hands back the cursor.
 *
 * Idempotent: createLeadsInInstance upserts by email, attach treats "already
 * present" as success, and lead_move_log rows use INSERT OR IGNORE — so a
 * retried batch never double-moves.
 *
 * Admin-gated. maxDuration 300.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import db from "@/lib/db";
import { sweepCampaignLeadsCursor, type OutboundLead } from "@/lib/outboundhero-api";
import { routeCandidates, type Candidate } from "@/lib/nurture/route-candidates";
import { detectCampaignEsp, type Esp } from "@/lib/nurture/esp";
import { type CampaignMapEntry } from "@/lib/nurture/campaign-map";
import { getServiceArea, cityInServiceArea, cityFromCustomVars, stateFromCustomVars } from "@/lib/service-area";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Bison caps reads at 15 leads/request, so reads are the bottleneck. We read in
// small SUB_WINDOW chunks and OVERLAP each chunk's write (create+attach+log)
// with the NEXT chunk's read — so the write time is largely hidden behind reads.
// A call returns after WINDOW leads or WINDOW_MS, handing back the cursor.
const WINDOW = 2500;       // leads processed per call before handing the cursor back
const SUB_WINDOW = 800;    // read chunk size; its write overlaps the next read
const WINDOW_MS = 170_000; // …or this much wall-time, whichever comes first (< maxDuration 300)

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: {
    clientTag?: string; sourceInstance?: string; sourceCampaignId?: number;
    sourceCampaignName?: string; targetInstance?: string; targetCampaignId?: number; cursor?: string | null;
    serviceAreaFilter?: boolean; runId?: string;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const clientTag = String(body.clientTag || "").trim().toUpperCase();
  const sourceInstance = String(body.sourceInstance || "").trim();
  const targetInstance = String(body.targetInstance || "").trim();
  const sourceCampaignId = Number(body.sourceCampaignId);
  const targetCampaignId = Number(body.targetCampaignId);
  const sourceCampaignName = String(body.sourceCampaignName || "");
  const startCursor = body.cursor ? String(body.cursor) : null;
  const serviceAreaFilter = body.serviceAreaFilter !== false; // default ON
  const runId = body.runId ? String(body.runId) : null;

  if (!clientTag || !sourceInstance || !targetInstance || !sourceCampaignId || !targetCampaignId) {
    return NextResponse.json({ error: "clientTag, sourceInstance, targetInstance, sourceCampaignId, targetCampaignId required" }, { status: 400 });
  }
  const esp = detectCampaignEsp(sourceCampaignName);
  if (!esp) {
    return NextResponse.json({ error: `cannot detect ESP from source campaign name "${sourceCampaignName}"` }, { status: 400 });
  }

  // Service-area gate: skip leads whose CITY isn't in the client's allowed area.
  // Only when the filter is on AND an area is configured AND the lead has a city.
  const area = serviceAreaFilter ? await getServiceArea(clientTag) : null;
  const ctx = { runId, clientTag, sourceInstance, sourceCampaignId, sourceCampaignName, targetInstance };

  // ── Pipelined sweep + write ──
  // Read sub-windows sequentially (cursor), but overlap each sub-window's write
  // with the NEXT sub-window's read. Writes are chained (one at a time), so
  // counters never race; reads run ahead. This hides most of the write time.
  let moved = 0, skippedCount = 0, fetched = 0;
  let cursor: string | null = startCursor;
  let done = false;
  const w: { error: Error | null } = { error: null }; // object property so the async-closure assignment isn't narrowed away
  let writeChain: Promise<void> = Promise.resolve();
  const deadline = Date.now() + WINDOW_MS;

  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    let s: { leads: OutboundLead[]; nextCursor: string | null; done: boolean };
    try {
      s = await sweepCampaignLeadsCursor(sourceInstance, sourceCampaignId, cursor, { maxLeads: SUB_WINDOW, maxMs: Math.min(remainingMs, 60_000) });
    } catch (e) {
      await writeChain; // let queued writes finish
      if (w.error) return NextResponse.json({ error: `move failed: ${w.error.message}` }, { status: 502 });
      if (fetched === 0) return NextResponse.json({ error: `fetch failed: ${(e as Error).message}` }, { status: 502 });
      return NextResponse.json({ ok: true, fetched, moved, skipped: skippedCount, nextCursor: cursor, done: false }); // resume from cursor
    }
    fetched += s.leads.length;
    cursor = s.nextCursor;
    done = s.done;

    // Partition this sub-window by service area.
    const kept: OutboundLead[] = [];
    const skippedLeads: OutboundLead[] = [];
    if (area) {
      for (const l of s.leads) {
        const city = cityFromCustomVars(l.custom_variables);
        if (city && !cityInServiceArea(city, area.tokens)) skippedLeads.push(l);
        else kept.push(l);
      }
    } else if (s.leads.length) {
      kept.push(...s.leads);
    }

    // Chain the write after the previous one; do NOT await here — loop back to
    // read the next sub-window while this write runs.
    const prev = writeChain;
    writeChain = (async () => {
      await prev;
      if (w.error) return;
      try {
        moved += await routeAndLog(kept, esp, targetCampaignId, ctx);
        if (skippedLeads.length) { await persistSkipped(skippedLeads, ctx); skippedCount += skippedLeads.length; }
      } catch (e) { w.error = e as Error; }
    })();

    if (done || !cursor || fetched >= WINDOW) break;
  }

  await writeChain;
  if (w.error) return NextResponse.json({ error: `move failed: ${w.error.message}` }, { status: 502 });

  return NextResponse.json({
    ok: true,
    fetched,
    moved,
    skipped: skippedCount,
    nextCursor: done ? null : cursor,
    done,
  });
}

/** Create+attach one batch of kept leads into the target campaign and record
 *  lead_move_log. Returns how many were attached. */
async function routeAndLog(
  kept: OutboundLead[], esp: Esp, targetCampaignId: number,
  ctx: { clientTag: string; sourceInstance: string; sourceCampaignId: number; targetInstance: string },
): Promise<number> {
  const candidates: Candidate[] = kept
    .filter((l) => (l.email || "").trim())
    .map((l) => ({
      source: "campaign" as const,
      rowId: l.id, email: l.email, esp,
      first_name: l.first_name ?? null, last_name: l.last_name ?? null, company: l.company ?? null,
      obLeadId: l.id, sourceInstance: ctx.sourceInstance,
      custom_variables: Array.isArray(l.custom_variables) ? l.custom_variables.filter((v) => v && v.name && v.value != null) : [],
      instance: ctx.targetInstance,
    }));
  if (!candidates.length) return 0;

  const map: CampaignMapEntry[] = [
    { bison_instance: ctx.targetInstance, esp, campaign_id: targetCampaignId, campaign_name: null, lane: null },
  ];
  let moved = 0;
  const nowIso = new Date().toISOString();
  await routeCandidates(ctx.clientTag, candidates, map, {
    onAttached: async (campaignId, resolved) => {
      moved += resolved.length;
      const rows = resolved.filter((r) => typeof r.obLeadId === "number");
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const ph = chunk.map(() => "(?,?,?,?,?,?,?,?)").join(",");
        const args = chunk.flatMap((r) => [
          ctx.clientTag, ctx.sourceInstance, ctx.sourceCampaignId, ctx.targetInstance, campaignId, r.obLeadId, r.email, nowIso,
        ]);
        try {
          await db.execute({
            sql: `INSERT OR IGNORE INTO lead_move_log
              (client_tag, source_instance, source_campaign_id, target_instance, target_campaign_id, ob_lead_id, email, moved_at)
              VALUES ${ph}`,
            args,
          });
        } catch { /* audit only — never fail the move on a log write */ }
      }
    },
  });
  return moved;
}

/** Record service-area-skipped leads (full detail + reason) for the export.
 *  INSERT OR REPLACE on (ob_lead_id, source_campaign_id) → idempotent on retries.
 *  Never throws — a skip-log failure must not fail the move. */
async function persistSkipped(
  leads: OutboundLead[],
  ctx: { runId: string | null; clientTag: string; sourceInstance: string; sourceCampaignId: number; sourceCampaignName: string; targetInstance: string },
) {
  const nowIso = new Date().toISOString();
  const COLS = 16;
  for (let i = 0; i < leads.length; i += 200) {
    const chunk = leads.slice(i, i + 200);
    const ph = chunk.map(() => `(${Array(COLS).fill("?").join(",")})`).join(",");
    const args = chunk.flatMap((l) => {
      const city = cityFromCustomVars(l.custom_variables);
      const state = stateFromCustomVars(l.custom_variables);
      return [
        ctx.runId, ctx.clientTag, ctx.sourceInstance, ctx.sourceCampaignId, ctx.sourceCampaignName, ctx.targetInstance,
        l.id, l.email ?? null, l.first_name ?? null, l.last_name ?? null, l.company ?? null,
        city, state, `out of service area${city ? ` (city: ${city})` : ""}`,
        JSON.stringify(Array.isArray(l.custom_variables) ? l.custom_variables : []), nowIso,
      ];
    });
    try {
      await db.execute({
        sql: `INSERT OR REPLACE INTO lead_move_skipped
          (run_id, client_tag, source_instance, source_campaign_id, source_campaign_name, target_instance,
           ob_lead_id, email, first_name, last_name, company, city, state, reason, custom_variables, skipped_at)
          VALUES ${ph}`,
        args,
      });
    } catch { /* audit only — never fail the move on a skip-log write */ }
  }
}
