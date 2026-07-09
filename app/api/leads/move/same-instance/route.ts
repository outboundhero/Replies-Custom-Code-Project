/**
 * POST /api/leads/move/same-instance
 *
 * Lane-aware mover for the Same Instance tab. Cursor-sweeps a SOURCE campaign's
 * leads and splits each by email type — personal → the client's B2C instance,
 * business → its B2B instance — routing to the chosen destination campaign at
 * (that lane's instance, the source's ESP). Reuses routeCandidates (attach for
 * same-instance leads, create+attach for cross-instance, idempotent).
 *
 * The caller re-invokes with `nextCursor` until `done`. Copy-only. Admin-gated.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import db from "@/lib/db";
import { sweepCampaignLeadsCursor, type OutboundLead } from "@/lib/outboundhero-api";
import { routeCandidates, type Candidate } from "@/lib/nurture/route-candidates";
import { detectCampaignEsp, type Esp } from "@/lib/nurture/esp";
import { type CampaignMapEntry } from "@/lib/nurture/campaign-map";
import { isPersonalDomain } from "@/lib/processing/personal-domains";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const WINDOW = 2500;
const SUB_WINDOW = 800;
const WINDOW_MS = 170_000;

interface Ctx {
  clientTag: string; esp: Esp; sourceInstance: string; sourceCampaignId: number;
  b2bInstance: string; b2cInstance: string; b2bCampaignId: number | null; b2cCampaignId: number | null;
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: {
    clientTag?: string; sourceInstance?: string; sourceCampaignId?: number; sourceCampaignName?: string;
    b2bInstance?: string; b2cInstance?: string; b2bCampaignId?: number | null; b2cCampaignId?: number | null;
    cursor?: string | null;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const clientTag = String(body.clientTag || "").trim().toUpperCase();
  const sourceInstance = String(body.sourceInstance || "").trim();
  const sourceCampaignId = Number(body.sourceCampaignId);
  const sourceCampaignName = String(body.sourceCampaignName || "");
  const b2bInstance = String(body.b2bInstance || "").trim();
  const b2cInstance = String(body.b2cInstance || "").trim();
  const b2bCampaignId = body.b2bCampaignId ? Number(body.b2bCampaignId) : null;
  const b2cCampaignId = body.b2cCampaignId ? Number(body.b2cCampaignId) : null;
  const startCursor = body.cursor ? String(body.cursor) : null;

  if (!clientTag || !sourceInstance || !sourceCampaignId || !b2bInstance || !b2cInstance) {
    return NextResponse.json({ error: "clientTag, sourceInstance, sourceCampaignId, b2bInstance, b2cInstance required" }, { status: 400 });
  }
  if (!b2bCampaignId && !b2cCampaignId) {
    return NextResponse.json({ error: "at least one of b2bCampaignId / b2cCampaignId required" }, { status: 400 });
  }
  const esp = detectCampaignEsp(sourceCampaignName);
  if (!esp) return NextResponse.json({ error: `cannot detect ESP from "${sourceCampaignName}"` }, { status: 400 });

  const ctx: Ctx = { clientTag, esp, sourceInstance, sourceCampaignId, b2bInstance, b2cInstance, b2bCampaignId, b2cCampaignId };

  // ── Pipelined sweep + write (mirrors /api/leads/move) ──
  let movedB2b = 0, movedB2c = 0, skipped = 0, fetched = 0;
  let cursor: string | null = startCursor;
  let done = false;
  const w: { error: Error | null } = { error: null };
  let writeChain: Promise<void> = Promise.resolve();
  const deadline = Date.now() + WINDOW_MS;

  for (;;) {
    if (deadline - Date.now() <= 0) break;
    let s: { leads: OutboundLead[]; nextCursor: string | null; done: boolean };
    try {
      s = await sweepCampaignLeadsCursor(sourceInstance, sourceCampaignId, cursor, { maxLeads: SUB_WINDOW, maxMs: Math.min(deadline - Date.now(), 60_000) });
    } catch (e) {
      await writeChain;
      if (w.error) return NextResponse.json({ error: `move failed: ${w.error.message}` }, { status: 502 });
      if (fetched === 0) return NextResponse.json({ error: `fetch failed: ${(e as Error).message}` }, { status: 502 });
      return NextResponse.json({ ok: true, fetched, movedB2b, movedB2c, skipped, nextCursor: cursor, done: false });
    }
    fetched += s.leads.length;
    cursor = s.nextCursor;
    done = s.done;

    const chunk = s.leads;
    const prev = writeChain;
    writeChain = (async () => {
      await prev;
      if (w.error) return;
      try {
        const r = await routeAndLogLane(chunk, ctx);
        movedB2b += r.movedB2b; movedB2c += r.movedB2c; skipped += r.skipped;
      } catch (e) { w.error = e as Error; }
    })();

    if (done || !cursor || fetched >= WINDOW) break;
  }

  await writeChain;
  if (w.error) return NextResponse.json({ error: `move failed: ${w.error.message}` }, { status: 502 });

  return NextResponse.json({ ok: true, fetched, movedB2b, movedB2c, skipped, nextCursor: done ? null : cursor, done });
}

/** Split a batch of leads by lane, route each to its lane's destination, record
 *  lead_move_log per bucket. Returns per-lane moved counts + skipped (no dest). */
async function routeAndLogLane(leads: OutboundLead[], ctx: Ctx): Promise<{ movedB2b: number; movedB2c: number; skipped: number }> {
  const candidates: Candidate[] = [];
  let skipped = 0;
  for (const l of leads) {
    const email = (l.email || "").trim();
    if (!email) continue;
    const lane: "b2b" | "b2c" = isPersonalDomain(email) ? "b2c" : "b2b";
    const targetCampaignId = lane === "b2c" ? ctx.b2cCampaignId : ctx.b2bCampaignId;
    if (!targetCampaignId) { skipped++; continue; } // this lane has no destination selected
    candidates.push({
      source: "campaign", rowId: l.id, email, esp: ctx.esp,
      first_name: l.first_name ?? null, last_name: l.last_name ?? null, company: l.company ?? null,
      obLeadId: l.id, sourceInstance: ctx.sourceInstance,
      custom_variables: Array.isArray(l.custom_variables) ? l.custom_variables.filter((v) => v && v.name && v.value != null) : [],
      lane, instance: lane === "b2c" ? ctx.b2cInstance : ctx.b2bInstance,
    });
  }

  const map: CampaignMapEntry[] = [];
  if (ctx.b2bCampaignId) map.push({ bison_instance: ctx.b2bInstance, esp: ctx.esp, campaign_id: ctx.b2bCampaignId, campaign_name: null, lane: "b2b" });
  if (ctx.b2cCampaignId) map.push({ bison_instance: ctx.b2cInstance, esp: ctx.esp, campaign_id: ctx.b2cCampaignId, campaign_name: null, lane: "b2c" });
  if (!candidates.length || !map.length) return { movedB2b: 0, movedB2c: 0, skipped };

  let movedB2b = 0, movedB2c = 0;
  const nowIso = new Date().toISOString();
  await routeCandidates(ctx.clientTag, candidates, map, {
    onAttached: async (campaignId, resolved) => {
      const targetInstance = String(resolved[0]?.instance || "");
      if (resolved[0]?.lane === "b2c") movedB2c += resolved.length; else movedB2b += resolved.length;
      const rows = resolved.filter((r) => typeof r.obLeadId === "number");
      for (let i = 0; i < rows.length; i += 200) {
        const c = rows.slice(i, i + 200);
        const ph = c.map(() => "(?,?,?,?,?,?,?,?)").join(",");
        const args = c.flatMap((r) => [ctx.clientTag, ctx.sourceInstance, ctx.sourceCampaignId, targetInstance, campaignId, r.obLeadId, r.email, nowIso]);
        try {
          await db.execute({
            sql: `INSERT OR IGNORE INTO lead_move_log
              (client_tag, source_instance, source_campaign_id, target_instance, target_campaign_id, ob_lead_id, email, moved_at)
              VALUES ${ph}`,
            args,
          });
        } catch { /* audit only */ }
      }
    },
  });
  return { movedB2b, movedB2c, skipped };
}
