/**
 * POST /api/costing/pull { pid? } — the Refresh button: pull one product (or all) now. Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getSession } from "@/lib/auth";
import { pullAll, pullProduct } from "@/lib/costing/pull";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const body = await req.json().catch(() => ({})) as { pid?: string };
  const who = (await getSession())?.email ?? "admin";
  try {
    const results = body.pid ? [await pullProduct(body.pid, { trigger: `refresh:${who}` })] : await pullAll(`refresh:${who}`);
    return NextResponse.json({ ok: results.every((r) => r.ok), results });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
