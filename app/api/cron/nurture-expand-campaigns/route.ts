/**
 * GET /api/cron/nurture-expand-campaigns
 *
 * Auto-expands nurture campaigns. For every client with a confirmed map
 * (non-churned), evaluates each instance-trio (the 3 ESP campaigns in one
 * workspace): when all 3 are >= 50% complete AND have > 5,000 combined leads,
 * it clones the trio (duplicate → re-attach senders → rename "… — Batch N" →
 * activate) and re-points the routing map to the clones so future leads flow
 * into the fresh campaigns. Also snapshots every routing's health each run for
 * the Campaigns monitoring tab.
 *
 * Schedule: daily (vercel.json). Auth: same CRON_SECRET pattern as other crons.
 */
import { NextRequest, NextResponse } from "next/server";
import { expandCampaignsForClient, listExpansionClients } from "@/lib/nurture/campaign-expansion";
import { logActivity, logError } from "@/lib/errors";

export const maxDuration = 300;

const SOFT_BUDGET_MS = 4.5 * 60 * 1000; // 270s — leaves headroom under the 5-min ceiling

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const tags = await listExpansionClients();
  const summary: Array<{ tag: string; expandedInstances: number; clones: number; errors: number }> = [];

  for (const tag of tags) {
    if (Date.now() - startedAt > SOFT_BUDGET_MS) {
      await logActivity("nurture-expand", "soft-budget-hit", {
        details: { processed: summary.length, remaining: tags.length - summary.length },
      });
      break;
    }
    try {
      const r = await expandCampaignsForClient(tag);
      const expandedInstances = r.instances.filter((i) => i.expanded).length;
      const clones = r.instances.reduce((s, i) => s + (i.clones?.length || 0), 0);
      const errors = r.instances.filter((i) => i.error).length + (r.error ? 1 : 0);
      if (expandedInstances > 0 || errors > 0) summary.push({ tag, expandedInstances, clones, errors });
    } catch (e) {
      await logError("nurture-expand", `fatal:${tag}`, (e as Error).message);
      summary.push({ tag, expandedInstances: 0, clones: 0, errors: 1 });
    }
  }

  await logActivity("nurture-expand", "completed", {
    details: {
      clients_checked: tags.length,
      clients_expanded: summary.filter((s) => s.expandedInstances > 0).length,
      total_clones: summary.reduce((s, x) => s + x.clones, 0),
      summary,
    },
  });

  return NextResponse.json({ ok: true, checked: tags.length, expanded: summary });
}
