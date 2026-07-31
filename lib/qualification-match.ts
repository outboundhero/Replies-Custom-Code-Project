/**
 * "Find the perfect client for a location + industry" matcher for the
 * Qualification section.
 *
 * The client qualification data (inclusion_locations + exclusion_industries)
 * ranges from broad ("USA", "Florida") to giant ZIP/county tables. Matching a
 * free-text query like "Mt Airy MD" against 190+ clients with an LLM directly
 * would be huge and expensive, so this does a cheap CODE pre-filter first
 * (nationwide + state/city/county text matches) and only sends the small
 * shortlist to the model. Results are cached in Turso keyed by the normalized
 * query + a data version, so repeat lookups cost zero AI credits.
 */

export interface QualClient {
  tag: string;
  status: string;
  exclusion_industries: string;
  inclusion_locations: string;
}

// US state abbreviation ↔ full name (both directions used for matching).
export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};

// NB: bare "national" is intentionally NOT here — it false-matches city names
// like "National City, CA" / "National Harbor, MD", flagging a regional client
// as nationwide. Use "nationwide"/"nationally"/"national coverage" instead.
const NATIONWIDE_RE = /\b(usa|u\.s\.a\.|united states|nationwide|nationally|national coverage|all (?:of )?(?:us|usa|states)|contiguous united states|entire (?:us|country))\b/i;

export interface ParsedQuery {
  stateAbbr: string | null;
  stateName: string | null;
  /** Non-state words from the query (candidate city/county/industry terms). */
  terms: string[];
  normalized: string;
}

export function parseQuery(raw: string): ParsedQuery {
  const normalized = raw.trim().replace(/\s+/g, " ");
  let stateAbbr: string | null = null;
  let stateName: string | null = null;

  // Full state name first (longest match), e.g. "New Hampshire".
  for (const [abbr, name] of Object.entries(US_STATES)) {
    if (new RegExp(`\\b${name.replace(/ /g, "\\s+")}\\b`, "i").test(normalized)) { stateAbbr = abbr; stateName = name; break; }
  }
  // Then a 2-letter state code. "Mt"/"St" collide with MT/ST-style words, so we
  // prefer an UPPERCASE code, and among candidates take the LAST one (the state
  // usually trails the city: "Mt Airy MD" → MD, not "Mt"→Montana).
  if (!stateAbbr) {
    const tokens = normalized.split(/[^A-Za-z]+/).filter(Boolean);
    const codes = tokens
      .map((t, i) => ({ t, i, up: t.toUpperCase() }))
      .filter((x) => x.t.length === 2 && US_STATES[x.up]);
    const upper = codes.filter((x) => x.t === x.up);
    const chosen = (upper.length ? upper : codes).slice(-1)[0];
    if (chosen) { stateAbbr = chosen.up; stateName = US_STATES[chosen.up]; }
  }

  // Remaining words (drop the state tokens) → city/county/industry terms.
  let rest = normalized;
  if (stateName) rest = rest.replace(new RegExp(`\\b${stateName.replace(/ /g, "\\s+")}\\b`, "gi"), " ");
  if (stateAbbr) rest = rest.replace(new RegExp(`\\b${stateAbbr}\\b`, "g"), " ");
  const terms = rest.split(/[,/]|\s+/).map((s) => s.trim()).filter((s) => s.length >= 3);
  // Expand "Mt" → "Mount" style abbreviations into a combined term set handled by caller.
  return { stateAbbr, stateName, terms, normalized };
}

export function isNationwide(loc: string): boolean {
  return NATIONWIDE_RE.test(loc.slice(0, 80)) || loc.trim().length <= 6 && /usa|us/i.test(loc);
}

/** Location term variants to search for (handles Mt/Mount, St/Saint). */
function termVariants(term: string): string[] {
  const t = term.toLowerCase();
  const out = new Set([t]);
  if (t === "mt") out.add("mount");
  if (t === "mount") out.add("mt");
  if (t === "st") out.add("saint");
  if (t === "saint") out.add("st");
  return [...out];
}

export interface Candidate {
  tag: string;
  nationwide: boolean;
  coverage: string;   // condensed relevant location snippet for the model
  exclusions: string;
}

/**
 * Code pre-filter: shortlist clients whose locations plausibly include the
 * query, each condensed to just the relevant lines (keeps the AI prompt tiny).
 */
export function shortlist(clients: QualClient[], parsed: ParsedQuery, cap = 15): Candidate[] {
  const stateNeedles: string[] = [];
  if (parsed.stateName) stateNeedles.push(parsed.stateName.toLowerCase());
  if (parsed.stateAbbr) stateNeedles.push(parsed.stateAbbr.toLowerCase());
  const termNeedles = parsed.terms.flatMap(termVariants);
  // Match city/county terms on WORD BOUNDARIES so "spring" doesn't hit
  // "Springfield" and "grove" doesn't hit "Grovetown" — those false substring
  // hits used to flood the shortlist with unrelated clients.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const termRes = termNeedles.map((n) => new RegExp(`\\b${esc(n)}\\b`));

  const nationwide: Candidate[] = [];
  const regional: Candidate[] = [];

  for (const c of clients) {
    const loc = (c.inclusion_locations || "").trim();
    if (!loc) continue;
    const nw = isNationwide(loc);

    // Which lines mention the state (as a whole word) or a city/county term?
    const lines = loc.split(/\n/);
    const hitLines: string[] = [];
    for (const line of lines) {
      const ll = line.toLowerCase();
      const stateHit = stateNeedles.some((n) => n.length === 2 ? new RegExp(`\\b${n}\\b`).test(ll) : ll.includes(n));
      const termHit = termRes.some((re) => re.test(ll));
      if (stateHit || termHit) { hitLines.push(line.trim().replace(/\s{2,}/g, " ")); if (hitLines.length >= 6) break; }
    }

    if (nw && hitLines.length === 0) {
      nationwide.push({ tag: c.tag, nationwide: true, coverage: `Nationwide (${loc.slice(0, 40).trim()})`, exclusions: (c.exclusion_industries || "").slice(0, 300) });
    } else if (hitLines.length > 0) {
      regional.push({ tag: c.tag, nationwide: nw, coverage: hitLines.join(" | ").slice(0, 400), exclusions: (c.exclusion_industries || "").slice(0, 300) });
    }
  }
  // Regional (specific) matches first, then nationwide fallbacks.
  return [...regional, ...nationwide].slice(0, cap);
}

/** How well one candidate client fits the query, on each axis. */
export interface FitMatch {
  tag: string;
  /** "full" = coverage includes the exact location; "partial" = same state/region
   *  but the specific city/county isn't listed; "none" = doesn't cover it. */
  location: "full" | "partial" | "none";
  /** "fit" = doesn't exclude the query industry; "excluded" = exclusions cover it;
   *  "na" = the query had no industry, so this axis doesn't apply. */
  industry: "fit" | "excluded" | "na";
  reason: string;
}

export interface MatchResult {
  match: { tag: string; reason: string; matched?: string } | null;   // best fit (location full + industry not excluded); `matched` = the exact coverage phrase that matched
  matches: FitMatch[];        // every classified candidate (best first), for the fit chips
  reason: string;             // human message (esp. for the no-match case)
  alternatives?: string[];    // other tags that fully cover it AND fit the industry
  candidatesConsidered: number;
  viaCache: boolean;
  aiUsed: boolean;
}

const NO_MATCH_MSG = "No client tag matches this location or industry.";

/** Order matches: best (full+fit) → other full-location → partial → none; each by industry fit. */
export function rankMatches(matches: FitMatch[]): FitMatch[] {
  const locRank = { full: 0, partial: 1, none: 2 };
  const indRank = { fit: 0, na: 1, excluded: 2 };
  return [...matches].sort((a, b) => (locRank[a.location] - locRank[b.location]) || (indRank[a.industry] - indRank[b.industry]) || a.tag.localeCompare(b.tag));
}

/**
 * Run the AI over the shortlist. Classifies EVERY candidate on both axes
 * (location + industry) so the UI can show the best fit plus near-misses
 * ("location fit but not industry fit", "industry fit but not location fit").
 */
export async function aiPickClient(location: string, candidates: Candidate[], industry?: string): Promise<{ best: string | null; reason: string; matched?: string; matches: FitMatch[] }> {
  const ind = (industry || "").trim();
  if (!process.env.OPENAI_API_KEY) {
    // No key → heuristic: shortlist is location-plausible, so mark them partial.
    const matches: FitMatch[] = candidates.map((c) => ({ tag: c.tag, location: "partial", industry: "na", reason: `Location signal: ${c.coverage}. [AI unavailable]` }));
    const top = candidates[0];
    return top ? { best: top.tag, reason: `Closest coverage match (${top.coverage}). [AI unavailable — heuristic pick]`, matched: top.coverage, matches } : { best: null, reason: NO_MATCH_MSG, matches: [] };
  }
  const system = [
    "You route a prospect (given a LOCATION and optionally an INDUSTRY) to the best-fit client, and you ALSO rate every other shortlisted client so a human can see near-misses.",
    "Each client has a COVERAGE area (where their prospects are) and EXCLUSIONS (industries they do NOT want).",
    "Respond with ONLY JSON: { \"best\": string|null, \"reason\": string, \"matched\": string, \"matches\": [ { \"tag\": string, \"location\": \"full\"|\"partial\"|\"none\", \"industry\": \"fit\"|\"excluded\"|\"na\", \"reason\": string } ] }",
    "Include one matches[] entry for EVERY client in the shortlist. Use your own geography knowledge (a city belongs to its county/state).",
    "First, work out the QUERY LOCATION's OWN county/region yourself (e.g. 'Rockleigh, NJ is in Bergen County'; 'Perth Amboy, NJ is in Middlesex County'). Judge each client against THAT — never justify a match with a DIFFERENT city that happens to be in the client's area.",
    "location: 'full' = the client's coverage explicitly includes the query location's OWN city or county, OR an explicit statewide/nationwide area that contains it. 'partial' = the coverage is the same STATE/broad region but NOT the query location's actual city/county (e.g. query is Bergen County but the client only lists Middlesex — that is 'partial', NOT 'full'). 'none' = does not cover it.",
    "industry: if NO Industry is provided below, set 'na' for ALL. Otherwise 'excluded' if the client's EXCLUSIONS cover that industry, else 'fit'.",
    "best: the tag whose location is 'full' AND industry is not 'excluded'. PREFER the most specific regional client over a nationwide one. If NO client's coverage includes the query location's own city/county (only same-state near-misses), best = null.",
    "reason (TOP-LEVEL, for the BEST pick): a SPECIFIC, verifiable justification the user can trust — no circular phrases like 'is included in its coverage area'. State (1) the containment chain for the QUERY LOCATION naming its actual county/region (e.g. 'San Mateo is a city in San Mateo County, in the SF Bay Area'), (2) the EXACT entry in this client's coverage that matches it (e.g. \"HS's coverage lists 'San Mateo County'\"), (3) if an industry was given, confirm it is not in this client's exclusions (name the industry). Then END with a confidence level exactly as 'Confidence: High' / 'Confidence: Medium' / 'Confidence: Low' (High = the query's own city/county is explicitly covered + industry fits; Medium = covered via a broad statewide/region entry or borderline industry; Low = weak/uncertain). If best is null, reason='" + NO_MATCH_MSG + "'.",
    "matched (TOP-LEVEL): copy the SHORT exact phrase from the best client's coverage that matched (e.g. 'San Mateo County' or 'statewide CA'), or '' if best is null.",
    "matches[].reason: ONE short clause (max 12 words) for the chip (e.g. 'Covers NJ but only Middlesex, not Bergen').",
  ].join("\n");
  const user = [
    `Location: ${location}`,
    ind ? `Industry: ${ind}` : "Industry: (none provided — set industry='na' for every client)",
    "",
    "Shortlist:",
    ...candidates.map((c) => `- ${c.tag} | coverage: ${c.coverage}${c.exclusions ? ` | excludes: ${c.exclusions}` : ""}`),
  ].join("\n");

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini", temperature: 0, max_tokens: 1800,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!res.ok) return { best: null, reason: NO_MATCH_MSG, matches: [] };
    const data = await res.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();
    const parsed = JSON.parse(raw) as { best?: string | null; reason?: string; matched?: string; matches?: Array<{ tag?: string; location?: string; industry?: string; reason?: string }> };
    const valid = new Set(candidates.map((c) => c.tag));
    const loc = (v: unknown): FitMatch["location"] => (v === "full" || v === "partial" ? v : "none");
    const ind = (v: unknown): FitMatch["industry"] => (v === "fit" || v === "excluded" ? v : "na");
    const matches: FitMatch[] = (parsed.matches || [])
      .filter((m) => m.tag && valid.has(m.tag.trim()))
      .map((m) => ({ tag: (m.tag as string).trim(), location: loc(m.location), industry: ind(m.industry), reason: (m.reason || "").trim() || "Coverage match." }));
    let best = (parsed.best || "").trim() || null;
    // Guard: best must be in the shortlist AND actually a full-location, non-excluded fit.
    if (best && !valid.has(best)) best = null;
    if (best && !matches.some((m) => m.tag === best && m.location === "full" && m.industry !== "excluded")) {
      const fallback = matches.find((m) => m.location === "full" && m.industry !== "excluded");
      best = fallback?.tag || null;
    }
    // Detailed top-level reason for the best pick; fall back to its chip reason.
    const reason = best
      ? ((parsed.reason || "").trim() || matches.find((m) => m.tag === best)?.reason || "Matched.")
      : NO_MATCH_MSG;
    const matched = best ? ((parsed.matched || "").trim() || undefined) : undefined;
    return { best, reason, matched, matches: rankMatches(matches) };
  } catch {
    return { best: null, reason: NO_MATCH_MSG, matches: [] };
  }
}

export { NO_MATCH_MSG };
