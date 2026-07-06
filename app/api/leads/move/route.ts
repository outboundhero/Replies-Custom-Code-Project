/**
 * POST /api/leads/move
 *
 * Lead Mover — one bounded batch: pull a page-window of a SOURCE campaign's
 * leads and copy them into a TARGET campaign (same or another Bison instance),
 * reusing the nurture routing core (routeCandidates: same-instance attach, or
 * cross-instance create+attach). The caller re-invokes with `page += PAGES` until
 * `done`. Copy-only — the source campaign is NOT modified (operator pauses it).
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
import { getCampaignLeadsPage, type OutboundLead } from "@/lib/outboundhero-api";
import { routeCandidates, type Candidate } from "@/lib/nurture/route-candidates";
import { detectCampaignEsp } from "@/lib/nurture/esp";
import { type CampaignMapEntry } from "@/lib/nurture/campaign-map";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGES_PER_BATCH = 40; // ~600 leads/call (Bison caps ~15/page) — well under maxDuration
const PER_PAGE = 100;

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: {
    clientTag?: string; sourceInstance?: string; sourceCampaignId?: number;
    sourceCampaignName?: string; targetInstance?: string; targetCampaignId?: number; page?: number;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const clientTag = String(body.clientTag || "").trim().toUpperCase();
  const sourceInstance = String(body.sourceInstance || "").trim();
  const targetInstance = String(body.targetInstance || "").trim();
  const sourceCampaignId = Number(body.sourceCampaignId);
  const targetCampaignId = Number(body.targetCampaignId);
  const sourceCampaignName = String(body.sourceCampaignName || "");
  const page = Math.max(1, Number(body.page) || 1);

  if (!clientTag || !sourceInstance || !targetInstance || !sourceCampaignId || !targetCampaignId) {
    return NextResponse.json({ error: "clientTag, sourceInstance, targetInstance, sourceCampaignId, targetCampaignId required" }, { status: 400 });
  }
  const esp = detectCampaignEsp(sourceCampaignName);
  if (!esp) {
    return NextResponse.json({ error: `cannot detect ESP from source campaign name "${sourceCampaignName}"` }, { status: 400 });
  }

  // Pull one page-window of ALL leads in the source campaign (no status filter).
  let leads: OutboundLead[] = [];
  let lastPage = page;
  try {
    const r = await getCampaignLeadsPage(sourceInstance, sourceCampaignId, page, PAGES_PER_BATCH, { perPage: PER_PAGE });
    leads = r.leads;
    lastPage = r.lastPage;
  } catch (e) {
    return NextResponse.json({ error: `fetch failed: ${(e as Error).message}` }, { status: 502 });
  }

  const candidates: Candidate[] = leads
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

  const nextPage = page + PAGES_PER_BATCH;
  const done = nextPage > lastPage || leads.length === 0;
  // Page pagination caps at ~1000 pages (~15k leads); flag if we hit it so the UI can warn.
  const truncated = !done && lastPage >= 1000 && nextPage > 1000;

  return NextResponse.json({
    ok: true,
    fetched: leads.length,
    moved,
    perBucket: result.perBucket,
    page, nextPage, lastPage, done, truncated,
  });
}
