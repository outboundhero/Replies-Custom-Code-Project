/**
 * GET /api/cron/bison-campaigns?secret=X&instance=outboundhero&q=SBCC
 *
 * Diagnostic: lists Bison campaigns matching `q` and, for each, the count of
 * leads in `sequence_finished` status (what the nurture sync pulls from).
 * Lets us see whether a client actually has sequence-finished leads in Bison.
 */
import { NextRequest, NextResponse } from "next/server";
import { getInstanceConfig } from "@/lib/bison-instances";
import { listCampaigns } from "@/lib/outboundhero-api";

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const instance = req.nextUrl.searchParams.get("instance") || "outboundhero";
  const q = req.nextUrl.searchParams.get("q") || "";
  const status = req.nextUrl.searchParams.get("status") || "sequence_finished";
  const campaignParam = req.nextUrl.searchParams.get("campaign");

  let baseUrl: string, token: string;
  try { ({ baseUrl, token } = getInstanceConfig(instance)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };

  // Syntax-probe mode: try several filter param formats against ONE campaign
  // and report lastPage for each. The format whose lastPage collapses (vs the
  // no-filter baseline) is the one Bison actually honors.
  const probeCampaign = req.nextUrl.searchParams.get("probe");
  if (probeCampaign) {
    const cid = Number(probeCampaign);
    const val = req.nextUrl.searchParams.get("status") || "bounced";
    const variants: Record<string, string> = {
      "no_filter": `per_page=100&page=1`,
      "filters.lead_campaign_status": `per_page=100&page=1&filters.lead_campaign_status=${val}`,
      "filter[lead_campaign_status]": `per_page=100&page=1&filter[lead_campaign_status]=${val}`,
      "lead_campaign_status": `per_page=100&page=1&lead_campaign_status=${val}`,
      "filters[lead_campaign_status]": `per_page=100&page=1&filters[lead_campaign_status]=${val}`,
      "status": `per_page=100&page=1&status=${val}`,
    };
    const out: Record<string, unknown> = {};
    for (const [name, qs] of Object.entries(variants)) {
      try {
        const res = await fetch(`${baseUrl}/api/campaigns/${cid}/leads?${qs}`, { headers });
        const d = res.ok ? await res.json() : null;
        out[name] = res.ok ? { lastPage: d?.meta?.last_page, total: d?.meta?.total, returned: (d?.data || []).length } : `HTTP ${res.status}`;
      } catch (e) { out[name] = `err ${(e as Error).message.slice(0, 30)}`; }
    }
    return NextResponse.json({ campaign: cid, value: val, variants: out });
  }

  // Single-campaign mode: page through the filtered leads and report the REAL
  // count (from data[], since meta.total is the unfiltered campaign total) plus
  // a sample, so we can confirm the lead_campaign_status filter actually works.
  if (campaignParam) {
    const cid = Number(campaignParam);
    // raw=1 → return the full first lead object so we can see every field.
    if (req.nextUrl.searchParams.get("raw") === "1") {
      const res = await fetch(`${baseUrl}/api/campaigns/${cid}/leads?per_page=2&page=1`, { headers });
      const d = res.ok ? await res.json() : { error: res.status };
      return NextResponse.json({ campaign: cid, metaKeys: Object.keys(d?.meta || {}), firstLead: (d?.data || [])[0] ?? null });
    }
    const maxPages = Math.min(60, Number(req.nextUrl.searchParams.get("maxPages") || 5));
    const startPage = Math.max(1, Number(req.nextUrl.searchParams.get("startPage") || 1));
    const endPage = startPage + maxPages - 1;
    // Tally each lead's REAL campaign status (lead_campaign_data[].status for
    // this campaign) across the scanned pages — the filter is ignored, so we
    // read it client-side.
    const tally: Record<string, number> = {};
    let total = 0, page = startPage, lastPage = 1;
    while (page <= endPage) {
      const res = await fetch(`${baseUrl}/api/campaigns/${cid}/leads?per_page=100&page=${page}`, { headers });
      if (!res.ok) return NextResponse.json({ error: `HTTP ${res.status}`, body: (await res.text()).slice(0, 200) }, { status: 502 });
      const d = await res.json();
      const rows = d?.data || [];
      lastPage = d?.meta?.last_page ?? page;
      total += rows.length;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of rows as any[]) {
        const lcd = Array.isArray(r.lead_campaign_data) ? r.lead_campaign_data.find((x: { campaign_id: number }) => x.campaign_id === cid) : r.lead_campaign_data;
        const st = lcd?.status || "(none)";
        tally[st] = (tally[st] || 0) + 1;
      }
      if (rows.length === 0 || page >= lastPage) break;
      page++;
    }
    return NextResponse.json({ instance, campaign: cid, startPage, pagesScanned: page - startPage, lastPage, leadsScanned: total, campaignStatusTally: tally });
  }

  let campaigns;
  try {
    campaigns = await listCampaigns(instance, q ? { search: q } : undefined);
  } catch (e) {
    return NextResponse.json({ error: `listCampaigns: ${(e as Error).message}` }, { status: 502 });
  }

  // For each campaign, fetch page 1 of leads filtered by status to read meta.total.
  const out = [];
  for (const c of campaigns.slice(0, 25)) {
    let statusCount: number | string = "?";
    try {
      const url = `${baseUrl}/api/campaigns/${c.id}/leads?per_page=1&page=1&filters.lead_campaign_status=${encodeURIComponent(status)}`;
      const res = await fetch(url, { headers });
      if (res.ok) {
        const d = await res.json();
        statusCount = (d?.meta?.total as number | undefined) ?? (d?.data?.length ?? 0);
      } else {
        statusCount = `HTTP ${res.status}`;
      }
    } catch (e) { statusCount = `err: ${(e as Error).message.slice(0, 40)}`; }
    out.push({
      id: c.id, name: c.name, status: c.status,
      total_leads: c.total_leads, replied: c.replied, bounced: c.bounced,
      [`${status}_count`]: statusCount,
    });
  }

  return NextResponse.json({ instance, q, statusFilter: status, campaignsFound: campaigns.length, campaigns: out });
}
