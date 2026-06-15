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
  const settled = await Promise.allSettled(BISON_INSTANCES.map((i) => listCampaigns(i.key)));
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

  // Only replace if we got a usable snapshot — never wipe the cache to empty
  // because every instance happened to fail this tick.
  if (rows.length > 0) {
    const now = new Date().toISOString();
    await db.execute("DELETE FROM nurture_campaigns_cache");
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      await db.batch(
        chunk.map((r) => ({
          sql: "INSERT OR REPLACE INTO nurture_campaigns_cache (id, uuid, name, status, client_tag, total_leads, bison_instance, synced_at) VALUES (?,?,?,?,?,?,?,?)",
          args: [r.id, r.uuid, r.name, r.status, r.client_tag, r.total_leads, r.bison_instance, now],
        })),
        "write",
      );
    }
  }

  return NextResponse.json({ ok: true, cached: rows.length, failures: failures.length ? failures : undefined });
}
