/**
 * POST /api/qualification/match  { query: "Mt Airy MD" }
 *
 * Suggests the best-fit client tag for a location (+ optional industry) from the
 * Qualification data, with a reason. Cheap CODE pre-filter → AI only on the
 * shortlist. Cached in Turso by (normalized query + data version) so repeat
 * lookups — and every empty-shortlist "no match" — cost zero AI credits.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";
import db from "@/lib/db";
import {
  parseQuery, shortlist, aiPickClient, NO_MATCH_MSG,
  type QualClient, type MatchResult,
} from "@/lib/qualification-match";

export const maxDuration = 30;

async function loadClients(): Promise<{ clients: QualClient[]; version: string }> {
  const { data } = await supabase
    .from("client_qualifications")
    .select("client_abbreviation, exclusion_industries, inclusion_locations, synced_at");
  const rows = data || [];
  let version = "0";
  const clients: QualClient[] = rows.map((r) => {
    const sa = (r.synced_at as string | null) || "";
    if (sa > version) version = sa;
    return {
      tag: r.client_abbreviation as string,
      status: "",
      exclusion_industries: (r.exclusion_industries as string | null) || "",
      inclusion_locations: (r.inclusion_locations as string | null) || "",
    };
  });
  return { clients, version };
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const query = String(body.query || "").trim();
    if (!query) return NextResponse.json({ error: "Empty query" }, { status: 400 });

    const key = query.toLowerCase().replace(/\s+/g, " ");
    const { clients, version } = await loadClients();

    // ── Cache check (Turso). Data version invalidates on resync. ──
    await db.execute("CREATE TABLE IF NOT EXISTS qual_match_cache (query_key TEXT PRIMARY KEY, data_version TEXT, result TEXT, created_at TEXT)");
    const cached = await db.execute({ sql: "SELECT result, data_version FROM qual_match_cache WHERE query_key = ?", args: [key] });
    if (cached.rows.length && cached.rows[0].data_version === version) {
      const result = JSON.parse(String(cached.rows[0].result)) as MatchResult;
      return NextResponse.json({ ...result, viaCache: true });
    }

    // ── Compute ──
    const parsed = parseQuery(query);
    const candidates = shortlist(clients, parsed);

    let result: MatchResult;
    if (candidates.length === 0) {
      // No plausible coverage → no AI call needed.
      result = { match: null, reason: NO_MATCH_MSG, candidatesConsidered: 0, viaCache: false, aiUsed: false };
    } else {
      const pick = await aiPickClient(query, candidates);
      result = pick.tag
        ? { match: { tag: pick.tag, reason: pick.reason }, reason: pick.reason, alternatives: pick.alternatives, candidatesConsidered: candidates.length, viaCache: false, aiUsed: true }
        : { match: null, reason: pick.reason || NO_MATCH_MSG, candidatesConsidered: candidates.length, viaCache: false, aiUsed: true };
    }

    // ── Store in cache ──
    await db.execute({
      sql: "INSERT INTO qual_match_cache (query_key, data_version, result, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(query_key) DO UPDATE SET data_version = excluded.data_version, result = excluded.result, created_at = excluded.created_at",
      args: [key, version, JSON.stringify(result), new Date().toISOString()],
    });

    return NextResponse.json(result);
  } catch (e) {
    console.error("[api/qualification/match] failed:", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
