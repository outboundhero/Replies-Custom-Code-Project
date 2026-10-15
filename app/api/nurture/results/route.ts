/**
 * GET /api/nurture/results?tag=TAG&days=30|90|all — leads delivered to clients,
 * by campaign stage (Main, Nurture 1, Nurture 2, …), inbox type and category,
 * for one client or all of them. Reads the small Turso table the 6-hourly job
 * keeps (lib/nurture/results.ts) — never the shared database.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { resultsView } from "@/lib/nurture/results";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const d = req.nextUrl.searchParams.get("days") || "90";
  const days = d === "all" ? null : [30, 90, 180, 365].includes(Number(d)) ? Number(d) : 90;
  const tag = (req.nextUrl.searchParams.get("tag") || "").trim() || null;
  try {
    return NextResponse.json({ ok: true, ...(await resultsView({ tag, days })) });
  } catch (e) {
    console.error("[api/nurture/results]", e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
