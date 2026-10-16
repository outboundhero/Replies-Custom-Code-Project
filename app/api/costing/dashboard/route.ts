/**
 * GET /api/costing/dashboard?from&to&group&product&category&vendor&model&client&feature&status&currency
 * Everything the Costing page shows, from stored figures (never calls a product). Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { buildDashboard } from "@/lib/costing/query";
import { isUtcDate } from "@/lib/costing/validate";
import { addDays, utcToday, daysBetween } from "@/lib/costing/pull";
import type { Group, StatusFilter } from "@/lib/costing/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const q = req.nextUrl.searchParams;
  const today = utcToday();
  const from = q.get("from") || `${today.slice(0, 7)}-01`;
  const to = q.get("to") || today;
  if (!isUtcDate(from) || !isUtcDate(to)) return NextResponse.json({ error: "from and to must be YYYY-MM-DD dates." }, { status: 400 });
  if (from > to) return NextResponse.json({ error: "from is after to." }, { status: 400 });
  if (daysBetween(from, to) > 3 * 366) return NextResponse.json({ error: "Choose a range of 3 years or less." }, { status: 400 });
  const group = (["day", "week", "month"].includes(q.get("group") ?? "") ? q.get("group") : "day") as Group;
  const status = (["final", "pending"].includes(q.get("status") ?? "") ? q.get("status") : "all") as StatusFilter;
  const opt = (k: string) => (q.get(k) || "").trim() || null;
  if (opt("client") && opt("feature")) return NextResponse.json({ error: "Filter by client or by feature, not both." }, { status: 400 });
  try {
    const d = await buildDashboard({
      from, to: to > addDays(today, 366) ? addDays(today, 366) : to, group, status,
      product: opt("product"), category: opt("category"), vendor: opt("vendor"), model: opt("model"),
      client: opt("client"), feature: opt("feature"), currency: opt("currency"),
    });
    return NextResponse.json(d);
  } catch (e) {
    console.error("[costing/dashboard]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
