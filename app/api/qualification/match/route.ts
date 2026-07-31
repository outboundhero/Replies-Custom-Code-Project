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

  // Only suggest ACTIVE + CLEANING clients — same rule as the inbox
  // suggested-client matcher (Turso client_meta: status "Active" + type
  // "Cleaning"). Non-Cleaning clients (SI, MISC, TSM, …) and non-Active
  // (Churned / Not Found / Paused) are never suggested. Falls open to
  // "non-churned" if client_meta isn't populated yet.
  let activeCleaning = new Set<string>();
  try {
    const meta = await db.execute("SELECT client_tag, client_type, status FROM client_meta");
    for (const m of meta.rows) {
      if (/^active$/i.test(String(m.status || "")) && /^cleaning$/i.test(String(m.client_type || ""))) {
        activeCleaning.add(String(m.client_tag).trim().toUpperCase());
      }
    }
  } catch { activeCleaning = new Set(); }
  const haveMeta = activeCleaning.size > 0;

  // Fallback churn set (used only when client_meta is unavailable). Same source
  // qualify-lead uses: client_status.status === "Churned".
  const churned = new Set<string>();
  if (!haveMeta) {
    const { data: statusRows } = await supabase.from("client_status").select("client_abbreviation, status");
    for (const s of statusRows || []) {
      if (String(s.status || "") === "Churned") churned.add(String(s.client_abbreviation || "").trim().toUpperCase());
    }
  }

  const keep = (tag: string) => {
    const t = tag.trim().toUpperCase();
    return haveMeta ? activeCleaning.has(t) : !churned.has(t);
  };

  let version = "0";
  const clients: QualClient[] = rows
    .filter((r) => keep(String(r.client_abbreviation || "")))
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
  // Fold the eligible roster into the version so cache invalidates when the
  // active+cleaning set changes (synced_at on the qualifications table alone
  // wouldn't catch a status/type change). v3 = active+cleaning filter added.
  const roster = haveMeta ? `ac${[...activeCleaning].sort().join(",")}` : `c${[...churned].sort().join(",")}`;
  const versioned = `v5|${version}|${roster}`;
  return { clients, version: versioned };
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    // New shape: { location (required), industry (optional) }. Back-compat: a
    // lone `query` string is treated as the location.
    const location = String(body.location || body.query || "").trim();
    const industry = String(body.industry || "").trim();
    if (!location) return NextResponse.json({ error: "Location is required" }, { status: 400 });

    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const key = `${norm(location)}||${norm(industry)}`;
    const { clients, version } = await loadClients();

    // ── Cache check (Turso). Data version invalidates on resync. ──
    await db.execute("CREATE TABLE IF NOT EXISTS qual_match_cache (query_key TEXT PRIMARY KEY, data_version TEXT, result TEXT, created_at TEXT)");
    const cached = await db.execute({ sql: "SELECT result, data_version FROM qual_match_cache WHERE query_key = ?", args: [key] });
    if (cached.rows.length && cached.rows[0].data_version === version) {
      const result = JSON.parse(String(cached.rows[0].result)) as MatchResult;
      return NextResponse.json({ ...result, viaCache: true });
    }

    // ── Compute ── (shortlist on LOCATION only; industry never pollutes it)
    const parsed = parseQuery(location);
    const candidates = shortlist(clients, parsed);

    let result: MatchResult;
    if (candidates.length === 0) {
      // No plausible coverage → no AI call needed.
      result = { match: null, matches: [], reason: NO_MATCH_MSG, candidatesConsidered: 0, viaCache: false, aiUsed: false };
    } else {
      const pick = await aiPickClient(location, candidates, industry);
      // Alternatives = other tags that fully cover it AND fit the industry (not the best).
      const alternatives = pick.matches
        .filter((m) => m.tag !== pick.best && m.location === "full" && m.industry !== "excluded")
        .map((m) => m.tag);
      result = pick.best
        ? { match: { tag: pick.best, reason: pick.reason, matched: pick.matched }, matches: pick.matches, reason: pick.reason, alternatives, candidatesConsidered: candidates.length, viaCache: false, aiUsed: true }
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
