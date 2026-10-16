/**
 * GET /api/cron/costing-pull — the daily pull of every product's costing feed (last 35 days, plus
 * any older day still pending). Products are pulled one after another; one failing doesn't stop
 * the others, and a failing product keeps its last good figures.
 */
import { NextRequest, NextResponse } from "next/server";
import { pullAll } from "@/lib/costing/pull";
import { logError } from "@/lib/errors";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const results = await pullAll("cron");
    for (const r of results) if (!r.ok) await logError("costing", "pull", `${r.name}: ${r.error}`).catch(() => undefined);
    return NextResponse.json({ ok: results.every((r) => r.ok), results });
  } catch (e) {
    await logError("costing", "pull", (e as Error).message).catch(() => undefined);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
