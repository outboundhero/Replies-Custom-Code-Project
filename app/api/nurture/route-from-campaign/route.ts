/**
 * POST /api/nurture/route-from-campaign
 *   { clientTag, sourceInstance, sourceCampaignId, sourceCampaignName, page }
 *
 * Fetches ONE page range of a SOURCE outbound campaign's leads and routes them
 * into the client's nurture campaigns via the confirmed map: lane (B2B/B2C from
 * each lead's email domain) → instance, ESP from the SOURCE campaign NAME. The
 * caller loops this with `page` += CHUNK until `done`, showing fetched/added
 * progress. No DB stamping (the source is a Bison campaign, not our DB rows).
 *
 * Auth: admin. Gated on a confirmed map + non-churned client.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { getCampaignLeadsPage } from "@/lib/outboundhero-api";
import { getCampaignMap, getMapConfirmedAt } from "@/lib/nurture/campaign-map";
import { getClientInstances } from "@/lib/nurture/group-routing";
import { getChurnedTags } from "@/lib/churn";
import { detectCampaignEsp } from "@/lib/nurture/esp";
import { isPersonalDomain } from "@/lib/processing/personal-domains";
import { routeCandidates, type Candidate } from "@/lib/nurture/route-candidates";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Bison's campaign-leads endpoint is locked to ~15/page regardless of per_page,
// so pull a wide page range per request to keep each batch ~600 leads & fast.
const PAGES_PER_BATCH = 40;
const PER_PAGE = 100;

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { clientTag?: string; sourceInstance?: string; sourceCampaignId?: number; sourceCampaignName?: string; page?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const clientTag = (body.clientTag || "").trim().toUpperCase();
  const sourceInstance = (body.sourceInstance || "").trim();
  const sourceCampaignId = Number(body.sourceCampaignId);
  const sourceCampaignName = body.sourceCampaignName || "";
  const page = Math.max(1, Number(body.page) || 1);
  if (!clientTag || !sourceInstance || !Number.isFinite(sourceCampaignId)) {
    return NextResponse.json({ error: "clientTag, sourceInstance, sourceCampaignId required" }, { status: 400 });
  }

  // Gates.
  if (!(await getMapConfirmedAt(clientTag))) return NextResponse.json({ error: "target-campaign map not confirmed" }, { status: 400 });
  if ((await getChurnedTags()).has(clientTag)) return NextResponse.json({ error: "client is churned" }, { status: 400 });

  const esp = detectCampaignEsp(sourceCampaignName);
  if (!esp) return NextResponse.json({ error: `no ESP detectable in source campaign name "${sourceCampaignName}"` }, { status: 400 });

  const instances = await getClientInstances(clientTag);
  if (!instances) return NextResponse.json({ error: "no group mapping — sync the group sheet" }, { status: 400 });
  const map = await getCampaignMap(clientTag);
  if (map.length === 0) return NextResponse.json({ error: "no campaigns mapped" }, { status: 400 });

  try {
    // 1. Fetch this batch of SEQUENCE-FINISHED source leads (no-reply nurture
    //    candidates only — not every lead in the campaign).
    const { leads, lastPage } = await getCampaignLeadsPage(sourceInstance, sourceCampaignId, page, PAGES_PER_BATCH, { perPage: PER_PAGE, leadCampaignStatus: "sequence_finished" });

    // 2. Build candidates: drop bounced / replied (mirror sync-sequence-finished),
    //    lane per lead, ESP from the source campaign name.
    const candidates: Candidate[] = [];
    let skipped = 0;
    for (const l of leads) {
      const email = l.email;
      if (!email) continue;
      // Belt-and-suspenders past the server-side sequence_finished filter.
      if (l.status === "bounced") { skipped++; continue; }
      if ((l.overall_stats?.replies ?? 0) > 0) { skipped++; continue; }
      const campData = l.lead_campaign_data;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = Array.isArray(campData) ? (campData as any[]).find((x) => x.campaign_id === sourceCampaignId) : campData;
      if (row && ((row.replies ?? 0) > 0 || row.status === "bounced" || (row.status && row.status !== "sequence_finished"))) { skipped++; continue; }
      const lane: "b2b" | "b2c" = isPersonalDomain(email) ? "b2c" : "b2b";
      candidates.push({
        source: "campaign",
        rowId: l.id,
        email,
        esp,
        first_name: l.first_name ?? null,
        last_name: l.last_name ?? null,
        company: l.company ?? null,
        obLeadId: l.id,
        sourceInstance,
        custom_variables: Array.isArray(l.custom_variables) ? l.custom_variables.filter((v) => v && v.name && v.value != null) : [],
        lane,
        instance: instances[lane],
      });
    }

    // 2b. Skip leads we've ALREADY routed (added_at set in our DB) so a re-run
    //     doesn't re-attach the same people — only genuinely-new leads route.
    let alreadyRouted = 0;
    let fresh = candidates;
    if (candidates.length > 0) {
      const ids = candidates.map((c) => c.obLeadId).filter((x): x is number => typeof x === "number");
      const added = new Set<number>();
      for (let i = 0; i < ids.length; i += 300) {
        const { data } = await supabase.from("nurture_sequence_finished")
          .select("ob_lead_id")
          .eq("client_tag", clientTag).eq("bison_instance", sourceInstance).not("added_at", "is", null)
          .in("ob_lead_id", ids.slice(i, i + 300));
        for (const r of data || []) added.add(Number((r as { ob_lead_id: number }).ob_lead_id));
      }
      fresh = candidates.filter((c) => !(typeof c.obLeadId === "number" && added.has(c.obLeadId)));
      alreadyRouted = candidates.length - fresh.length;
    }

    // 3. Route via the shared core. Stamp the matching nurture_sequence_finished
    //    rows added_at + nurture_campaign_id (by ob_lead_id in the source
    //    instance) so the READY/ADDED tiles update and "Route all ready" doesn't
    //    re-route these same leads.
    const routed = fresh.length > 0
      ? await routeCandidates(clientTag, fresh, map, {
          onAttached: async (campaignId, resolved) => {
            const ids = resolved.map((r) => r.obLeadId).filter((x): x is number => typeof x === "number");
            const stamp = new Date().toISOString();
            for (let i = 0; i < ids.length; i += 300) {
              const chunk = ids.slice(i, i + 300);
              await supabase.from("nurture_sequence_finished")
                .update({ added_at: stamp, nurture_campaign_id: campaignId })
                .eq("client_tag", clientTag).eq("bison_instance", sourceInstance).is("added_at", null).in("ob_lead_id", chunk);
            }
          },
        })
      : { perBucket: [], totalAttached: 0 };

    const nextPage = page + PAGES_PER_BATCH;
    const done = nextPage > lastPage || leads.length === 0;

    return NextResponse.json({
      fetched: leads.length,        // sequence-finished leads pulled this batch
      eligible: candidates.length,  // after dropping replied/bounced
      fresh: fresh.length,          // not already routed
      alreadyRouted,                // skipped — already added in a prior run
      skipped,
      added: routed.totalAttached,
      perBucket: routed.perBucket,
      esp,
      page,
      nextPage,
      lastPage,
      done,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
