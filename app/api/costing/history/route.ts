/**
 * GET /api/costing/history?pid — the change log (every amount / status / field change a re-pull
 * made, and items a product stopped reporting) and recent pulls. Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { listChanges, recentPulls } from "@/lib/costing/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const pid = req.nextUrl.searchParams.get("pid") || null;
  const [changes, pulls] = await Promise.all([listChanges(pid, 300), recentPulls(pid ? 100 : 60)]);
  return NextResponse.json({ changes, pulls: pid ? pulls.filter((p) => p.pid === pid) : pulls });
}
