/**
 * GET /api/cron/refresh-nurture-campaigns?secret=X
 *
 * Snapshots every "[Nurture]"-named campaign across all Bison instances into
 * the Turso `nurture_campaigns_cache` table. /api/nurture/campaigns reads that
 * table (instant, shared across serverless instances) instead of paginating
 * Bison live on every page load (which was the 30-60s "From/To campaigns won't
 * show" + "needs multiple refreshes" problem — the old in-process cache was
 * per-instance so cold loads missed constantly).
 *
 * Wire to a ~10-min Vercel cron; also callable manually after creating campaigns.
 */
import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { listCampaigns } from "@/lib/outboundhero-api";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import { BISON_INSTANCES } from "@/lib/bison-instances";
import { reactivateCompletedNurture } from "@/lib/nurture/reactivate-completed";
import { rebuildOverviewSnapshot } from "@/lib/nurture/overview-snapshot";

export const maxDuration = 300;

interface Row { id: number; uuid: string | null; name: string; status: string; client_tag: string | null; total_leads: number; bison_instance: string }

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Pull nurture campaigns from every instance (allSettled so one bad instance
  // doesn't sink the snapshot).
  // strict: a failed page fails that instance (its cached rows are kept)
  // instead of silently dropping campaigns from the cache.
  const settled = await Promise.allSettled(BISON_INSTANCES.map((i) => listCampaigns(i.key, { strict: true })));
  const rows: Row[] = [];
  const failures: string[] = [];
  settled.forEach((s, idx) => {
    const key = BISON_INSTANCES[idx].key;
    if (s.status === "fulfilled") {
      for (const c of s.value) {
        if (!/\bnurture\b/i.test(c.name || "")) continue;
        rows.push({
          id: c.id, uuid: c.uuid ?? null, name: c.name, status: c.status,
          client_tag: extractTagFromCampaignName(c.name) || null,
          total_leads: c.total_leads ?? 0, bison_instance: key,
        });
      }
    } else failures.push(`${key}: ${(s.reason as Error)?.message || "unknown"}`);
  });

  await db.execute(
    `CREATE TABLE IF NOT EXISTS nurture_campaigns_cache (
      id INTEGER, uuid TEXT, name TEXT, status TEXT, client_tag TEXT,
      total_leads INTEGER, bison_instance TEXT, synced_at TEXT,
      PRIMARY KEY (id, bison_instance)
    )`,
  );

  // Replace ONLY the instances that answered (a failed instance keeps its last
  // rows), each in one transaction so a reader never sees a half-filled cache.
  {
    const now = new Date().toISOString();
    for (let idx = 0; idx < settled.length; idx++) {
      if (settled[idx].status !== "fulfilled") continue;
      const key = BISON_INSTANCES[idx].key;
      const mine = rows.filter((r) => r.bison_instance === key);
      await db.batch([
        { sql: "DELETE FROM nurture_campaigns_cache WHERE bison_instance = ?", args: [key] },
        ...mine.map((r) => ({
          sql: "INSERT OR REPLACE INTO nurture_campaigns_cache (id, uuid, name, status, client_tag, total_leads, bison_instance, synced_at) VALUES (?,?,?,?,?,?,?,?)",
          args: [r.id, r.uuid, r.name, r.status, r.client_tag, r.total_leads, r.bison_instance, now],
        })),
      ], "write");
    }
  }

  // Also snapshot every tagged NON-nurture ("main") campaign — the Nurture
  // overview shows active main campaigns per client tag. Same lists as above,
  // so no extra Bison calls. Replaced per instance only when that instance's
  // list came back (a failed instance keeps its previous snapshot).
  try {
    await db.execute(
      `CREATE TABLE IF NOT EXISTS main_campaigns_cache (
        id INTEGER, bison_instance TEXT, client_tag TEXT, name TEXT, status TEXT,
        total_leads INTEGER, synced_at TEXT, PRIMARY KEY (id, bison_instance)
      )`,
    );
    const now = new Date().toISOString();
    for (let idx = 0; idx < settled.length; idx++) {
      const s = settled[idx];
      if (s.status !== "fulfilled") continue;
      const key = BISON_INSTANCES[idx].key;
      const mains = s.value
        .filter((c) => !/\bnurture\b/i.test(c.name || ""))
        .map((c) => ({ c, tag: extractTagFromCampaignName(c.name) }))
        .filter((x) => !!x.tag);
      // One transaction per instance (same reason as above).
      await db.batch([
        { sql: "DELETE FROM main_campaigns_cache WHERE bison_instance = ?", args: [key] },
        ...mains.map(({ c, tag }) => ({
          sql: "INSERT OR REPLACE INTO main_campaigns_cache (id, bison_instance, client_tag, name, status, total_leads, synced_at) VALUES (?,?,?,?,?,?,?)",
          args: [c.id, key, tag, c.name, c.status, c.total_leads ?? 0, now],
        })),
      ], "write");
    }
  } catch (e) {
    console.error("[cron/refresh-nurture-campaigns] main-campaign snapshot failed:", (e as Error).message);
  }

  // Revive any nurture campaigns that have gone "completed" (Bison stops them,
  // silently killing nurture for the client). Reuse the lists we already paged
  // above so this adds no extra Bison list calls. Never let it sink the refresh.
  let revived: Awaited<ReturnType<typeof reactivateCompletedNurture>> | undefined;
  try {
    const campaignsByInstance: Record<string, typeof rows[number][]> = {};
    settled.forEach((s, idx) => {
      if (s.status === "fulfilled") {
        campaignsByInstance[BISON_INSTANCES[idx].key] = s.value as unknown as typeof rows[number][];
      }
    });
    revived = await reactivateCompletedNurture({ campaignsByInstance });
  } catch (e) {
    console.error("[cron/refresh-nurture-campaigns] revive-completed failed:", (e as Error).message);
  }

  // The Nurture pages read a precomputed overview — refresh it with the new
  // campaign snapshot. Never let it sink the refresh.
  try { await rebuildOverviewSnapshot(); } catch (e) {
    console.error("[cron/refresh-nurture-campaigns] overview snapshot failed:", (e as Error).message);
  }

  return NextResponse.json({
    ok: true,
    cached: rows.length,
    failures: failures.length ? failures : undefined,
    revivedCompleted: revived ? { completed: revived.completed, revived: revived.revived, skipped: revived.skipped, failed: revived.failed } : undefined,
  });
}
