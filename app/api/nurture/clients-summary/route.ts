/**
 * GET /api/nurture/clients-summary
 *
 * Returns one row per client tag with the four headline counts
 * (Ready / Eligible / Waiting / Added) that drive the hub's client cards.
 *
 * Implementation: a single Supabase RPC call to `nurture_clients_summary`,
 * a Postgres function that UNION-ALLs the three source tables, GROUPs by
 * client_tag, and returns the aggregated counts in one round trip.
 *
 * INSTALL THIS in Supabase SQL editor before this endpoint can work:
 *
 *   CREATE OR REPLACE FUNCTION nurture_clients_summary(cutoff timestamptz)
 *   RETURNS TABLE (
 *     client_tag text, ready bigint, eligible bigint, waiting bigint, added bigint
 *   )
 *   LANGUAGE sql STABLE
 *   AS $$
 *     WITH excluded AS (
 *       SELECT unnest(ARRAY[
 *         'Interested','Meeting Request','Meeting Set','Do Not Contact',
 *         'Wrong Person','Wrong Person (Change of Target)','Not Interested',
 *         'Mailbox No Longer Active','Automated Error Message',
 *         'Automated Catch-All Message','Referral Given','Internally Forwarded'
 *       ]) AS cat
 *     ),
 *     unioned AS (
 *       SELECT
 *         client_tag,
 *         CASE WHEN reply_time <= cutoff AND nurture_added_at IS NULL
 *                   AND COALESCE(nurture_skipped, false) = false
 *                   AND nurture_safety = 'safe' THEN 1 ELSE 0 END AS ready,
 *         CASE WHEN reply_time <= cutoff AND nurture_added_at IS NULL
 *                   AND COALESCE(nurture_skipped, false) = false THEN 1 ELSE 0 END AS eligible,
 *         CASE WHEN reply_time >  cutoff AND nurture_added_at IS NULL
 *                   AND COALESCE(nurture_skipped, false) = false THEN 1 ELSE 0 END AS waiting,
 *         CASE WHEN nurture_added_at IS NOT NULL THEN 1 ELSE 0 END AS added
 *       FROM replies
 *       WHERE reply_we_got IS NOT NULL AND reply_we_got <> ''
 *         AND reply_time IS NOT NULL
 *         AND client_tag IS NOT NULL AND client_tag <> 'N/A'
 *         AND (ai_categorized_lead_category IS NULL
 *              OR ai_categorized_lead_category NOT IN (SELECT cat FROM excluded))
 *
 *       UNION ALL
 *
 *       SELECT
 *         client_tag,
 *         CASE WHEN sequence_finished_at <= cutoff AND added_at IS NULL
 *                   AND COALESCE(skipped, false) = false THEN 1 ELSE 0 END,
 *         CASE WHEN sequence_finished_at <= cutoff AND added_at IS NULL
 *                   AND COALESCE(skipped, false) = false THEN 1 ELSE 0 END,
 *         CASE WHEN sequence_finished_at >  cutoff AND added_at IS NULL
 *                   AND COALESCE(skipped, false) = false THEN 1 ELSE 0 END,
 *         CASE WHEN added_at IS NOT NULL THEN 1 ELSE 0 END
 *       FROM nurture_sequence_finished
 *       WHERE client_tag IS NOT NULL AND client_tag <> 'N/A'
 *
 *       UNION ALL
 *
 *       SELECT
 *         client_tag,
 *         CASE WHEN reply_at <= cutoff AND nurture_added_at IS NULL
 *                   AND COALESCE(nurture_skipped, false) = false
 *                   AND nurture_safety = 'safe' THEN 1 ELSE 0 END,
 *         CASE WHEN reply_at <= cutoff AND nurture_added_at IS NULL
 *                   AND COALESCE(nurture_skipped, false) = false THEN 1 ELSE 0 END,
 *         CASE WHEN reply_at >  cutoff AND nurture_added_at IS NULL
 *                   AND COALESCE(nurture_skipped, false) = false THEN 1 ELSE 0 END,
 *         CASE WHEN nurture_added_at IS NOT NULL THEN 1 ELSE 0 END
 *       FROM nurture_legacy_leads
 *       WHERE client_tag IS NOT NULL AND client_tag <> 'N/A'
 *         AND (original_ai_category IS NULL
 *              OR original_ai_category NOT IN (SELECT cat FROM excluded))
 *     )
 *     SELECT
 *       client_tag,
 *       SUM(ready)::bigint    AS ready,
 *       SUM(eligible)::bigint AS eligible,
 *       SUM(waiting)::bigint  AS waiting,
 *       SUM(added)::bigint    AS added
 *     FROM unioned
 *     GROUP BY client_tag
 *     ORDER BY client_tag;
 *   $$;
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import supabase from "@/lib/supabase";

export const maxDuration = 60;

const NURTURE_DAYS = 45;

interface ClientSummary {
  clientTag: string;
  ready: number;
  eligible: number;
  waiting: number;
  added: number;
  total: number;
}

let cache: { ts: number; data: ClientSummary[] } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function GET(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const now = Date.now();
  if (!fresh && cache && now - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json({ clients: cache.data, cached: true });
  }

  try {
    const cutoffIso = new Date(now - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Fast path: read the precomputed cache table (refreshed by the
    // refresh-nurture-summary cron). This is a sub-100ms indexed read vs the
    // ~8s live RPC, and — unlike the in-process cache — it's shared across all
    // serverless instances. Skip it on ?fresh=1 (force live recompute).
    if (!fresh) {
      const { data: cached, error: cacheErr } = await supabase
        .from("nurture_summary_cache")
        .select("client_tag, ready, eligible, waiting, added");
      if (!cacheErr && cached && cached.length > 0) {
        const out: ClientSummary[] = cached.map((r) => ({
          clientTag: r.client_tag as string,
          ready: Number(r.ready) || 0,
          eligible: Number(r.eligible) || 0,
          waiting: Number(r.waiting) || 0,
          added: Number(r.added) || 0,
          total: (Number(r.ready) || 0) + (Number(r.waiting) || 0) + (Number(r.added) || 0),
        }));
        cache = { ts: now, data: out };
        return NextResponse.json({ clients: out, cached: true, source: "table" });
      }
      // Table missing/empty (not installed yet, or cron hasn't run) → fall
      // through to the live RPC so the hub still works.
    }

    const { data, error } = await supabase.rpc("nurture_clients_summary", { cutoff: cutoffIso });
    if (error) {
      const msg = error.message || "";
      const hint = error.hint || "";
      // Postgres returns "function nurture_clients_summary(...) does not exist"
      // when the SQL function hasn't been installed yet. Give a useful hint.
      if (msg.includes("nurture_clients_summary") && msg.includes("does not exist")) {
        return NextResponse.json(
          {
            error: "Postgres function `nurture_clients_summary` is not installed in Supabase. Install it via the SQL editor (see the SQL in the route file's docblock) and refresh.",
            installRequired: true,
          },
          { status: 503 },
        );
      }
      console.error("[api/nurture/clients-summary] RPC failed:", msg, hint);
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    type RpcRow = { client_tag: string; ready: number; eligible: number; waiting: number; added: number };
    const rows = (data as RpcRow[] | null) || [];
    const out: ClientSummary[] = rows.map((r) => ({
      clientTag: r.client_tag,
      ready: Number(r.ready) || 0,
      eligible: Number(r.eligible) || 0,
      waiting: Number(r.waiting) || 0,
      added: Number(r.added) || 0,
      total: (Number(r.ready) || 0) + (Number(r.waiting) || 0) + (Number(r.added) || 0),
    }));

    cache = { ts: now, data: out };
    return NextResponse.json({ clients: out, cached: false });
  } catch (error) {
    console.error("[api/nurture/clients-summary] GET failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
