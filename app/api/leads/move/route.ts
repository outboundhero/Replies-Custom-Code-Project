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
import { detectCampaignEsp } from "@/lib/nurture/esp";
import { type CampaignMapEntry } from "@/lib/nurture/campaign-map";
import { getServiceArea, cityInServiceArea, cityFromCustomVars, stateFromCustomVars } from "@/lib/service-area";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Reads are ~1.6k leads/min per stream, so a big window nears the 300s route
// ceiling → timeout → wasted re-read. Keep windows small: fast to return, so
// progress updates ~every minute and nothing times out. Concurrency (not window
// size) drives total throughput — reads scale cleanly with no rate-limiting.
const WINDOW = 1200;       // leads copied per call before handing the cursor back
const WINDOW_MS = 150_000; // …or this much wall-time, whichever comes first (< maxDuration 300)

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
  const cursor = body.cursor ? String(body.cursor) : null;
  const serviceAreaFilter = body.serviceAreaFilter !== false; // default ON
  const runId = body.runId ? String(body.runId) : null;

  if (!clientTag || !sourceInstance || !targetInstance || !sourceCampaignId || !targetCampaignId) {
    return NextResponse.json({ error: "clientTag, sourceInstance, targetInstance, sourceCampaignId, targetCampaignId required" }, { status: 400 });
  }
  const esp = detectCampaignEsp(sourceCampaignName);
  if (!esp) {
    return NextResponse.json({ error: `cannot detect ESP from source campaign name "${sourceCampaignName}"` }, { status: 400 });
  }

  // Cursor-sweep one window of the source campaign's leads (no status filter = all).
  let sweep: { leads: import("@/lib/outboundhero-api").OutboundLead[]; nextCursor: string | null; done: boolean };
  try {
    sweep = await sweepCampaignLeadsCursor(sourceInstance, sourceCampaignId, cursor, { maxLeads: WINDOW, maxMs: WINDOW_MS });
  } catch (e) {
    return NextResponse.json({ error: `fetch failed: ${(e as Error).message}` }, { status: 502 });
  }
  const leads = sweep.leads;

  // ── Service-area gate ──
  // Skip leads whose CITY isn't in the client's allowed area. Only applies when
  // the filter is on AND the client has an area configured AND the lead has a
  // city. Missing city / no area / filter off → the lead is moved.
  const area = serviceAreaFilter ? await getServiceArea(clientTag) : null;
  let kept = leads;
  const skippedLeads: OutboundLead[] = [];
  if (area) {
    kept = [];
    for (const l of leads) {
      const city = cityFromCustomVars(l.custom_variables);
      if (city && !cityInServiceArea(city, area.tokens)) skippedLeads.push(l);
      else kept.push(l);
    }
    if (skippedLeads.length) {
      await persistSkipped(skippedLeads, {
        runId, clientTag, sourceInstance, sourceCampaignId, sourceCampaignName, targetInstance,
      });
    }
  }

  const candidates: Candidate[] = kept
    .filter((l) => (l.email || "").trim())
    .map((l) => ({
      source: "campaign" as const,
      rowId: l.id,
      email: l.email,
      esp,
      first_name: l.first_name ?? null,
      last_name: l.last_name ?? null,
      company: l.company ?? null,
      obLeadId: l.id,
      sourceInstance,
      custom_variables: Array.isArray(l.custom_variables) ? l.custom_variables.filter((v) => v && v.name && v.value != null) : [],
      instance: targetInstance, // route everything to the chosen destination
    }));

  const map: CampaignMapEntry[] = [
    { bison_instance: targetInstance, esp, campaign_id: targetCampaignId, campaign_name: null, lane: null },
  ];

  let moved = 0;
  const nowIso = new Date().toISOString();
  const result = await routeCandidates(clientTag, candidates, map, {
    onAttached: async (campaignId, resolved) => {
      moved += resolved.length;
      const rows = resolved.filter((r) => typeof r.obLeadId === "number");
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const ph = chunk.map(() => "(?,?,?,?,?,?,?,?)").join(",");
        const args = chunk.flatMap((r) => [
          clientTag, sourceInstance, sourceCampaignId, targetInstance, campaignId, r.obLeadId, r.email, nowIso,
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

  return NextResponse.json({
    ok: true,
    fetched: leads.length,
    moved,
    skipped: skippedLeads.length,
    perBucket: result.perBucket,
    nextCursor: sweep.nextCursor,
    done: sweep.done,
  });
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
