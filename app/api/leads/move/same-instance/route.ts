/**
 * POST /api/leads/move/same-instance
 *
 * Lane-aware mover for the Same Instance tab. Cursor-sweeps a SOURCE campaign's
 * leads and routes each to the chosen destination at (its LANE instance, its
 * ESP):
 *   • lane  = isPersonalDomain(email) ? "b2c" : "b2b"  (personal→B2C, business→B2B)
 *   • ESP   = per-lead, from the lead's Bison ESP tag (findLeadByEmail) when the
 *             source is a Google/unknown catch-all campaign — so SEGs/Outlook
 *             leads hidden inside a "Google + Custom" campaign route correctly.
 *             Outlook/SEGs-named source campaigns are trusted from the name (no
 *             per-lead lookup). Falls back to the email-domain heuristic.
 *
 * routeCandidates then attaches same-instance leads and create+attaches cross-
 * instance ones (idempotent). Caller re-invokes with `nextCursor` until `done`.
 * Copy-only. Admin-gated.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import db from "@/lib/db";
import { sweepCampaignLeadsCursor, findLeadByEmail, type OutboundLead } from "@/lib/outboundhero-api";
import { routeCandidates, type Candidate } from "@/lib/nurture/route-candidates";
import { detectCampaignEsp, bucketEsp, detectEsp, pickEspFromTags, type Esp } from "@/lib/nurture/esp";
import { type CampaignMapEntry } from "@/lib/nurture/campaign-map";
import { isPersonalDomain } from "@/lib/processing/personal-domains";
import { getServiceArea, cityInServiceArea, cityFromCustomVars, stateFromCustomVars } from "@/lib/service-area";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ESPS: Esp[] = ["google", "outlook", "segs"];
const LANES = ["b2b", "b2c"] as const;
type Lane = (typeof LANES)[number];
type DestMap = { b2b: Partial<Record<Esp, number>>; b2c: Partial<Record<Esp, number>> };

async function parallelForEach<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

interface Ctx {
  clientTag: string; sourceInstance: string; sourceCampaignId: number; sourceCampaignName: string;
  b2bInstance: string; b2cInstance: string; dest: DestMap;
  campaignEsp: Esp | null; needsLookup: boolean;
  area: Awaited<ReturnType<typeof getServiceArea>>; runId: string | null;
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: {
    clientTag?: string; sourceInstance?: string; sourceCampaignId?: number; sourceCampaignName?: string;
    b2bInstance?: string; b2cInstance?: string; dest?: DestMap; cursor?: string | null;
    serviceAreaFilter?: boolean; runId?: string;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const clientTag = String(body.clientTag || "").trim().toUpperCase();
  const sourceInstance = String(body.sourceInstance || "").trim();
  const sourceCampaignId = Number(body.sourceCampaignId);
  const sourceCampaignName = String(body.sourceCampaignName || "");
  const b2bInstance = String(body.b2bInstance || "").trim();
  const b2cInstance = String(body.b2cInstance || "").trim();
  const dest: DestMap = { b2b: body.dest?.b2b || {}, b2c: body.dest?.b2c || {} };
  const startCursor = body.cursor ? String(body.cursor) : null;
  const serviceAreaFilter = body.serviceAreaFilter !== false; // default ON
  const runId = body.runId ? String(body.runId) : null;

  if (!clientTag || !sourceInstance || !sourceCampaignId || !b2bInstance || !b2cInstance) {
    return NextResponse.json({ error: "clientTag, sourceInstance, sourceCampaignId, b2bInstance, b2cInstance required" }, { status: 400 });
  }
  const anyDest = ESPS.some((e) => dest.b2b[e] || dest.b2c[e]);
  if (!anyDest) return NextResponse.json({ error: "no destination campaigns selected" }, { status: 400 });

  const campaignEsp = detectCampaignEsp(sourceCampaignName);
  // Google (catch-all) or an un-ESP'd name → resolve each lead's ESP from its
  // Bison tags. Outlook/SEGs names are specific enough to trust directly.
  const needsLookup = campaignEsp !== "outlook" && campaignEsp !== "segs";
  // Service-area gate: skip leads whose CITY isn't in the client's allowed area.
  // Only when the filter is on AND an area is configured (else move all).
  const area = serviceAreaFilter ? await getServiceArea(clientTag) : null;
  const ctx: Ctx = { clientTag, sourceInstance, sourceCampaignId, sourceCampaignName, b2bInstance, b2cInstance, dest, campaignEsp, needsLookup, area, runId };

  // Per-lead lookups make each call much heavier — use a smaller window there.
  const WINDOW = needsLookup ? 800 : 2500;
  const SUB_WINDOW = needsLookup ? 400 : 800;
  const WINDOW_MS = 230_000;

  const movedByKey: Record<string, number> = {};
  let skipped = 0, skippedArea = 0, fetched = 0;
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
      return NextResponse.json({ ok: true, fetched, movedByKey, skipped, skippedArea, nextCursor: cursor, done: false });
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
        for (const [k, n] of Object.entries(r.movedByKey)) movedByKey[k] = (movedByKey[k] || 0) + n;
        skipped += r.skipped;
        skippedArea += r.skippedArea;
      } catch (e) { w.error = e as Error; }
    })();

    if (done || !cursor || fetched >= WINDOW) break;
  }

  await writeChain;
  if (w.error) return NextResponse.json({ error: `move failed: ${w.error.message}` }, { status: 502 });

  return NextResponse.json({ ok: true, fetched, movedByKey, skipped, skippedArea, nextCursor: done ? null : cursor, done });
}

/** Resolve each lead's ESP (per-lead tags for catch-all sources), split by lane,
 *  route to the (lane, ESP) destination, record lead_move_log. */
async function routeAndLogLane(leads: OutboundLead[], ctx: Ctx): Promise<{ movedByKey: Record<string, number>; skipped: number; skippedArea: number }> {
  // Service-area gate FIRST — partition the WHOLE chunk exactly like the Cross
  // Instance mover: every lead is gated by city, out-of-area leads are logged +
  // counted (email presence is only checked later when building candidates), and
  // it runs before the expensive per-lead ESP lookup. Missing city → keep (move);
  // no area configured → ctx.area is null → keep all.
  let gated = leads;
  let skippedArea = 0;
  if (ctx.area) {
    const inArea: OutboundLead[] = [];
    const outArea: OutboundLead[] = [];
    for (const l of leads) {
      const city = cityFromCustomVars(l.custom_variables);
      if (city && !cityInServiceArea(city, ctx.area.tokens)) outArea.push(l);
      else inArea.push(l);
    }
    if (outArea.length) { await persistSkipped(outArea, ctx); skippedArea += outArea.length; }
    gated = inArea;
  }
  const withEmail = gated.filter((l) => (l.email || "").trim());

  // ESP per lead.
  const espByEmail = new Map<string, Esp>();
  if (!ctx.needsLookup && ctx.campaignEsp) {
    for (const l of withEmail) espByEmail.set(l.email, ctx.campaignEsp);
  } else {
    await parallelForEach(withEmail, 8, async (l) => {
      let esp: Esp;
      try {
        const full = await findLeadByEmail(ctx.sourceInstance, l.email);
        const tag = pickEspFromTags(full?.tags);
        esp = tag ? bucketEsp(tag) : detectEsp(l.email);
      } catch { esp = detectEsp(l.email); }
      espByEmail.set(l.email, esp);
    });
  }

  const candidates: Candidate[] = [];
  let skipped = 0;
  const usedKeys = new Set<string>();
  for (const l of withEmail) {
    const esp = espByEmail.get(l.email) || "google";
    const lane: Lane = isPersonalDomain(l.email) ? "b2c" : "b2b";
    const targetCampaignId = ctx.dest[lane][esp];
    if (!targetCampaignId) { skipped++; continue; } // no destination for this (lane, ESP)
    usedKeys.add(`${lane}:${esp}`);
    candidates.push({
      source: "campaign", rowId: l.id, email: l.email, esp,
      first_name: l.first_name ?? null, last_name: l.last_name ?? null, company: l.company ?? null,
      obLeadId: l.id, sourceInstance: ctx.sourceInstance,
      custom_variables: Array.isArray(l.custom_variables) ? l.custom_variables.filter((v) => v && v.name && v.value != null) : [],
      lane, instance: lane === "b2c" ? ctx.b2cInstance : ctx.b2bInstance,
    });
  }

  const map: CampaignMapEntry[] = [];
  for (const lane of LANES) {
    const inst = lane === "b2c" ? ctx.b2cInstance : ctx.b2bInstance;
    for (const esp of ESPS) {
      const cid = ctx.dest[lane][esp];
      if (cid && usedKeys.has(`${lane}:${esp}`)) map.push({ bison_instance: inst, esp, campaign_id: cid, campaign_name: null, lane });
    }
  }
  if (!candidates.length || !map.length) return { movedByKey: {}, skipped, skippedArea };

  const movedByKey: Record<string, number> = {};
  const nowIso = new Date().toISOString();
  await routeCandidates(ctx.clientTag, candidates, map, {
    onAttached: async (campaignId, resolved) => {
      const lane = resolved[0]?.lane || "b2b";
      const esp = resolved[0]?.esp || "google";
      const targetInstance = String(resolved[0]?.instance || "");
      movedByKey[`${lane}:${esp}`] = (movedByKey[`${lane}:${esp}`] || 0) + resolved.length;
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
  return { movedByKey, skipped, skippedArea };
}

/** Record service-area-skipped leads (full detail + reason) for the export.
 *  INSERT OR REPLACE on (ob_lead_id, source_campaign_id) → idempotent on retries.
 *  Same shape as the Cross Instance mover; target_instance = source instance
 *  (same-instance moves keep leads within their own instance). Never throws. */
async function persistSkipped(leads: OutboundLead[], ctx: Ctx) {
  const nowIso = new Date().toISOString();
  const COLS = 16;
  for (let i = 0; i < leads.length; i += 200) {
    const chunk = leads.slice(i, i + 200);
    const ph = chunk.map(() => `(${Array(COLS).fill("?").join(",")})`).join(",");
    const args = chunk.flatMap((l) => {
      const city = cityFromCustomVars(l.custom_variables);
      const state = stateFromCustomVars(l.custom_variables);
      return [
        ctx.runId, ctx.clientTag, ctx.sourceInstance, ctx.sourceCampaignId, ctx.sourceCampaignName, ctx.sourceInstance,
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
