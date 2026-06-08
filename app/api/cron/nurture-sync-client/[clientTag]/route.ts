/**
 * GET /api/cron/nurture-sync-client/[clientTag]
 *
 * Per-client targeted sync using Bison's `search` filter. Pulls only
 * the ~10 campaigns matching this client tag (instead of the instance's
 * 477) so we never hit the per-IP rate limit. Useful for:
 *   - manually backfilling a specific client (curl this URL)
 *   - one-off recovery after a missed cron
 *
 * Resolves the right Bison instance for the client from client_instances.
 * Auth: same CRON_SECRET as other cron jobs.
 */
import { NextRequest, NextResponse } from "next/server";
import { syncOneClient } from "@/lib/nurture/sync-sequence-finished";
import { resolveInstanceForClient } from "@/lib/bison-instances";
import { logActivity, logError } from "@/lib/errors";

export const maxDuration = 300;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ clientTag: string }> },
) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { clientTag: raw } = await params;
  const clientTag = raw.toUpperCase();
  if (!clientTag) {
    return NextResponse.json({ error: "clientTag required" }, { status: 400 });
  }

  const instanceKey = await resolveInstanceForClient(clientTag);

  // pages cap protects the 5-min route budget. Each call covers up to N
  // pages PER CAMPAIGN. For mega-clients (JPNYC has campaigns with 1,021
  // pages of sequence_finished leads), one call can't reach everything —
  // hit the endpoint multiple times to backfill incrementally. Bison
  // returns leads in roughly chronological order without filter support,
  // so each repeat call fetches the same first N pages, which is fine —
  // upserts dedupe and only new arrivals at the top get added.
  const pagesParam = Number(req.nextUrl.searchParams.get("pages") || 100);
  const maxPagesPerCampaign = Number.isFinite(pagesParam) && pagesParam > 0 ? pagesParam : 100;

  try {
    const result = await syncOneClient(instanceKey, clientTag, { maxPagesPerCampaign });

    await logActivity("nurture-sync-client", "completed", {
      client_tag: clientTag,
      details: {
        instance: instanceKey,
        campaigns: result.campaignsScanned,
        candidates: result.candidatesFound,
        upserted: result.upserted,
        error_count: result.errors.length,
      },
    });

    for (const e of result.errors.slice(0, 20)) {
      await logError("nurture-sync-client", `${clientTag}@${instanceKey}`, e);
    }

    return NextResponse.json({ ok: true, clientTag, instanceKey, ...result });
  } catch (error) {
    await logError("nurture-sync-client", `fatal:${clientTag}@${instanceKey}`, (error as Error).message);
    return NextResponse.json({ error: `Sync failed: ${(error as Error).message}` }, { status: 500 });
  }
}
