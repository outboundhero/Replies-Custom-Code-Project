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

  // Churned clients must never be suggested. Same source qualify-lead uses:
  // client_status.status === "Churned" (synced from the Client Tracker sheet).
  const { data: statusRows } = await supabase.from("client_status").select("client_abbreviation, status");
  const churned = new Set<string>();
  for (const s of statusRows || []) {
    if (String(s.status || "") === "Churned") churned.add(String(s.client_abbreviation || "").trim().toUpperCase());
  }

  let version = "0";
  const clients: QualClient[] = rows
    .filter((r) => !churned.has(String(r.client_abbreviation || "").trim().toUpperCase()))
    .map((r) => {
      const sa = (r.synced_at as string | null) || "";
      if (sa > version) version = sa;
      return {
        tag: r.client_abbreviation as string,
        status: "",
        exclusion_industries: (r.exclusion_industries as string | null) || "",
        inclusion_locations: (r.inclusion_locations as string | null) || "",
      };
    });
  // Fold the churned roster into the version so cache invalidates when a client
  // churns/un-churns (its synced_at may not change on the qualifications table).
  const versioned = `v2|${version}|c${[...churned].sort().join(",")}`;
  return { clients, version: versioned };
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
      result = { match: null, matches: [], reason: NO_MATCH_MSG, candidatesConsidered: 0, viaCache: false, aiUsed: false };
    } else {
      const pick = await aiPickClient(query, candidates);
      // Alternatives = other tags that fully cover it AND fit the industry (not the best).
      const alternatives = pick.matches
        .filter((m) => m.tag !== pick.best && m.location === "full" && m.industry !== "excluded")
        .map((m) => m.tag);
      result = pick.best
        ? { match: { tag: pick.best, reason: pick.reason }, matches: pick.matches, reason: pick.reason, alternatives, candidatesConsidered: candidates.length, viaCache: false, aiUsed: true }
        : { match: null, matches: pick.matches, reason: pick.reason || NO_MATCH_MSG, candidatesConsidered: candidates.length, viaCache: false, aiUsed: true };
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
