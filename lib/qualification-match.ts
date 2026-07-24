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

const NATIONWIDE_RE = /\b(usa|u\.s\.a\.|united states|nationwide|national|all (?:of )?(?:us|usa|states)|contiguous united states|entire (?:us|country))\b/i;

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
export function shortlist(clients: QualClient[], parsed: ParsedQuery, cap = 25): Candidate[] {
  const stateNeedles: string[] = [];
  if (parsed.stateName) stateNeedles.push(parsed.stateName.toLowerCase());
  if (parsed.stateAbbr) stateNeedles.push(parsed.stateAbbr.toLowerCase());
  const termNeedles = parsed.terms.flatMap(termVariants);

  const nationwide: Candidate[] = [];
  const regional: Candidate[] = [];

  for (const c of clients) {
    const loc = (c.inclusion_locations || "").trim();
    if (!loc) continue;
    const lower = loc.toLowerCase();
    const nw = isNationwide(loc);

    // Which lines mention the state (as a whole word) or a city/county term?
    const lines = loc.split(/\n/);
    const hitLines: string[] = [];
    for (const line of lines) {
      const ll = line.toLowerCase();
      const stateHit = stateNeedles.some((n) => n.length === 2 ? new RegExp(`\\b${n}\\b`).test(ll) : ll.includes(n));
      const termHit = termNeedles.some((n) => ll.includes(n));
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

export interface MatchResult {
  match: { tag: string; reason: string } | null;
  reason: string;             // human message (esp. for the no-match case)
  alternatives?: string[];    // other covering tags
  candidatesConsidered: number;
  viaCache: boolean;
  aiUsed: boolean;
}

const NO_MATCH_MSG = "No client tag matches this location or industry.";

/** Run the AI over the shortlist. Returns best tag + reason, or null. */
export async function aiPickClient(query: string, candidates: Candidate[]): Promise<{ tag: string | null; reason: string; alternatives?: string[] }> {
  if (!process.env.OPENAI_API_KEY) {
    // No key → fall back to the top shortlist entry (regional first).
    const top = candidates[0];
    return top ? { tag: top.tag, reason: `Closest coverage match (${top.coverage}). [AI unavailable — heuristic pick]` } : { tag: null, reason: NO_MATCH_MSG };
  }
  const system = [
    "You route a prospect (given a LOCATION and optionally an INDUSTRY) to the single best-fit client from a shortlist.",
    "Each client has a COVERAGE area (where their prospects are) and EXCLUSIONS (industries they do NOT want).",
    "Respond with ONLY JSON: { \"tag\": string|null, \"reason\": string, \"alternatives\": string[] }",
    "Rules:",
    "  - Pick the client whose COVERAGE includes the query location. Use your own geography knowledge (a city belongs to its county/state).",
    "  - PREFER the most specific regional client that covers the location over a nationwide one. Use a nationwide client only if no regional client covers it.",
    "  - If an INDUSTRY is given, do NOT pick a client whose EXCLUSIONS cover that industry.",
    "  - reason: one specific sentence naming WHY (e.g. 'Mt Airy is in Carroll County, MD, which PBS covers').",
    "  - alternatives: other tags that also cover it (may be empty).",
    "  - If NO client covers the location (or all that do exclude the industry), return tag=null and reason='" + NO_MATCH_MSG + "'.",
  ].join("\n");
  const user = [
    `Query: ${query}`,
    "",
    "Shortlist:",
    ...candidates.map((c) => `- ${c.tag} | coverage: ${c.coverage}${c.exclusions ? ` | excludes: ${c.exclusions}` : ""}`),
  ].join("\n");

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini", temperature: 0, max_tokens: 250,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!res.ok) return { tag: null, reason: NO_MATCH_MSG };
    const data = await res.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();
    const parsed = JSON.parse(raw) as { tag?: string | null; reason?: string; alternatives?: string[] };
    const tag = (parsed.tag || "").trim() || null;
    // Guard: the model must pick a tag that was actually in the shortlist.
    if (tag && !candidates.some((c) => c.tag === tag)) return { tag: null, reason: NO_MATCH_MSG };
    return { tag, reason: parsed.reason || (tag ? "Matched." : NO_MATCH_MSG), alternatives: (parsed.alternatives || []).filter((a) => candidates.some((c) => c.tag === a)) };
  } catch {
    return { tag: null, reason: NO_MATCH_MSG };
  }
}

export { NO_MATCH_MSG };
