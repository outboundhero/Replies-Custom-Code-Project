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

  let baseUrl: string, token: string;
  try { ({ baseUrl, token } = getInstanceConfig(instance)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };

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
