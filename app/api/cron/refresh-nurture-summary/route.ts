/**
 * GET /api/cron/refresh-nurture-summary?secret=X
 *
 * Recomputes the per-client nurture counts via the heavy nurture_clients_summary
 * RPC (scans replies + seq + legacy, ~8s) and persists them into the
 * nurture_summary_cache table. The hub's /api/nurture/clients-summary endpoint
 * reads that table instead of running the RPC live, so the dashboard is instant
 * for every serverless instance (the old in-process cache was per-instance and
 * missed constantly).
 *
 * Wire this to a Vercel cron (every ~10 min) in vercel.json. Also callable
 * manually after a big sync to refresh immediately.
 *
 * Requires the table (run once in Supabase):
 *   CREATE TABLE IF NOT EXISTS nurture_summary_cache (
 *     client_tag text PRIMARY KEY,
 *     ready bigint, eligible bigint, waiting bigint, added bigint,
 *     updated_at timestamptz DEFAULT now()
 *   );
 */
import { NextRequest, NextResponse } from "next/server";
import supabase from "@/lib/supabase";

export const maxDuration = 60;

const NURTURE_DAYS = 45;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase.rpc("nurture_clients_summary", { cutoff: cutoffIso });
  if (error) {
    return NextResponse.json({ error: `RPC failed: ${error.message}` }, { status: 500 });
  }

  type RpcRow = { client_tag: string; ready: number; eligible: number; waiting: number; added: number };
  const rows = (data as RpcRow[] | null) || [];
  const updatedAt = new Date().toISOString();
  const payload = rows.map((r) => ({
    client_tag: r.client_tag,
    ready: Number(r.ready) || 0,
    eligible: Number(r.eligible) || 0,
    waiting: Number(r.waiting) || 0,
    added: Number(r.added) || 0,
    updated_at: updatedAt,
  }));

  if (payload.length > 0) {
    const { error: upErr } = await supabase
      .from("nurture_summary_cache")
      .upsert(payload, { onConflict: "client_tag" });
    if (upErr) {
      return NextResponse.json({ error: `cache upsert failed: ${upErr.message}` }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, clients: payload.length, updatedAt });
}
