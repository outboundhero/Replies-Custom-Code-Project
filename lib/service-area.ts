/**
 * Service-area gate for the Lead Mover.
 *
 * Each client has a freeform "Inclusion Locations" string on the Onboarding Form
 * sheet (zips, counties, cities, states, mixed). For the migration we want a fast
 * deterministic check: is a lead's CITY/TOWN inside the client's allowed area? We
 * parse the city/town names out of that string (dropping states, ZIPs, counties),
 * store the normalized token list in Turso (`client_service_area`, refreshed by a
 * 12h cron), and match a lead's `city` custom variable against it.
 *
 * Match is intentionally FORGIVING ("contains", both directions) after stripping
 * case/apostrophes/dashes/spaces — mirroring the team's Clay service-area check.
 * Decisions: missing city → PASS (move); no area configured → PASS (move all).
 *
 * NOT the LLM `auditLocation` (lib/qualification/location-audit.ts) — that's for
 * one-off qualification, far too slow/costly per lead at migration scale.
 */
import db from "@/lib/db";

// US states + Canadian provinces — full names + abbreviations, normalized
// (a-z0-9 only). Used to drop pure-state entries and strip a trailing state/
// province from a "City ST" / "City ON" entry.
const US_STATES = new Set<string>([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
  "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
  "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
  "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "newhampshire",
  "newjersey", "newmexico", "newyork", "northcarolina", "northdakota", "ohio", "oklahoma",
  "oregon", "pennsylvania", "rhodeisland", "southcarolina", "southdakota", "tennessee",
  "texas", "utah", "vermont", "virginia", "washington", "westvirginia", "wisconsin",
  "wyoming", "districtofcolumbia",
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in",
  "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv",
  "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn",
  "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
  // Canadian provinces/territories (a few clients are Canadian).
  "alberta", "britishcolumbia", "manitoba", "newbrunswick", "newfoundlandandlabrador",
  "novascotia", "ontario", "princeedwardisland", "quebec", "saskatchewan",
  "northwestterritories", "nunavut", "yukon",
  "ab", "bc", "mb", "nb", "nl", "ns", "on", "pe", "qc", "sk", "nt", "nu", "yt",
]);

// Real place tokens are short-ish; anything longer is prose/URLs/notes.
const MAX_TOKEN_LEN = 30;
// A real city/town service area lists several places. A client that parses to
// fewer than this is treated as "no area" (move all) — this guards against a
// freeform string that yielded only a junk token (e.g. a stray "zipcode"),
// which would otherwise skip EVERY lead. Safe direction: move, don't skip.
const MIN_AREA_TOKENS = 2;

/** Lowercase and strip everything except a-z0-9 (case, apostrophes, dashes, spaces, punctuation). */
export function normalizePlace(s: string | null | undefined): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const isZip = (norm: string) => /^\d{5}(\d{4})?$/.test(norm);

/** Drop a trailing state from an entry like "Harrison NY" / "Mount Kisco New York". */
function stripTrailingState(entry: string): string {
  let words = entry.trim().split(/\s+/).filter(Boolean);
  for (const n of [3, 2, 1]) {
    if (words.length > n && US_STATES.has(normalizePlace(words.slice(-n).join("")))) {
      words = words.slice(0, -n);
      break;
    }
  }
  return words.join(" ");
}

/**
 * Parse a freeform inclusion-locations string into a deduped list of normalized
 * city/town tokens. Drops ZIPs, US states, and county entries; strips a trailing
 * state from a "City, ST" entry; keeps tokens of length >= 3.
 */
export function parseServiceArea(inclusion: string | null | undefined): string[] {
  if (!inclusion) return [];
  const out = new Set<string>();
  // Split on comma / newline / semicolon / period. Periods matter: freeform
  // entries often glue a city to the end of a sentence ("…Johnston County North
  // Carolina. Raleigh"), and without splitting there the county-drop rule below
  // would take the real city (Raleigh) down with it.
  for (const rawEntry of inclusion.split(/[,\n;.]+/)) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    if (/\bcounty\b|\bcounties\b/i.test(entry)) continue; // drop counties
    const whole = normalizePlace(entry);
    if (!whole || US_STATES.has(whole) || isZip(whole)) continue;
    const norm = normalizePlace(stripTrailingState(entry));
    // Drop: too short, too long (prose/URLs), pure-digit (zip/junk), or a state.
    if (!norm || norm.length < 3 || norm.length > MAX_TOKEN_LEN) continue;
    if (/^\d+$/.test(norm) || US_STATES.has(norm) || isZip(norm)) continue;
    out.add(norm);
  }
  return [...out];
}

/** Read a named custom variable (case-insensitive) from the ARRAY form used by
 *  OutboundLead / Candidate (`Array<{name,value}>`). NOT the Record form that
 *  lib/processing/custom-vars-extractor.ts expects. */
function readVar(vars: Array<{ name: string; value: string }> | undefined | null, name: string): string | null {
  if (!Array.isArray(vars)) return null;
  const target = name.toLowerCase();
  const v = vars.find((x) => x && typeof x.name === "string" && x.name.toLowerCase().trim() === target);
  const val = v?.value;
  return val != null && String(val).trim() ? String(val).trim() : null;
}
export const cityFromCustomVars = (vars: Array<{ name: string; value: string }> | undefined | null) => readVar(vars, "city");
export const stateFromCustomVars = (vars: Array<{ name: string; value: string }> | undefined | null) => readVar(vars, "state");

/**
 * True when a lead's city is inside the service area (or should be moved anyway).
 * Missing city → true (move on missing data). No tokens → true (no area = move all).
 * Otherwise a forgiving "contains" match, both directions, on normalized strings.
 */
export function cityInServiceArea(city: string | null | undefined, tokens: string[]): boolean {
  const nc = normalizePlace(city);
  if (!nc) return true;          // missing city → pass (move)
  if (!tokens.length) return true; // no area configured → pass (move all)
  for (const t of tokens) {
    if (t === nc) return true;
    if (nc.length >= 3 && t.length >= 3 && (nc.includes(t) || t.includes(nc))) return true;
  }
  return false;
}

// ── Turso-backed loader (5-min in-process cache, mirrors lib/churn.ts) ──

interface ServiceArea { tokens: string[]; raw: string }
let cache: { map: Map<string, ServiceArea>; ts: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

function safeTokens(cities: unknown): string[] {
  try {
    const parsed = JSON.parse(String(cities ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}

export async function loadServiceAreas(): Promise<Map<string, ServiceArea>> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.map;
  const map = new Map<string, ServiceArea>();
  try {
    const res = await db.execute("SELECT client_tag, cities, raw FROM client_service_area");
    for (const r of res.rows) {
      map.set(String(r.client_tag).toUpperCase(), { tokens: safeTokens(r.cities), raw: String(r.raw ?? "") });
    }
  } catch { /* table not created yet → nobody has an area */ }
  cache = { map, ts: Date.now() };
  return map;
}

export function invalidateServiceAreaCache() { cache = null; }

/** A client's parsed service area, or null when none is configured (no row, or the
 *  inclusion string parsed to zero city tokens → treat as "move all"). */
export async function getServiceArea(tag: string | null | undefined): Promise<ServiceArea | null> {
  if (!tag) return null;
  const entry = (await loadServiceAreas()).get(tag.toUpperCase());
  return entry && entry.tokens.length >= MIN_AREA_TOKENS ? entry : null;
}

/**
 * Rebuild the Turso `client_service_area` table from the Onboarding Form sheet.
 * Reads the sheet directly (self-contained, no dependency on the Supabase sync's
 * freshness), splits combined abbreviations, parses each inclusion string, and
 * full-replaces the table. Shared by the 12h cron + any manual trigger.
 */
export async function syncServiceAreas(): Promise<{ count: number; withArea: number; tags: string[] }> {
  const { fetchOnboardingForm } = await import("@/lib/google-sheets");
  const rows = await fetchOnboardingForm();
  const map = new Map<string, ServiceArea>();
  for (const r of rows) {
    const tags = r.clientAbbreviation.split(/[&/,]+/).map((s) => s.trim()).filter(Boolean);
    const tokens = parseServiceArea(r.inclusionLocations);
    for (const tag of tags) map.set(tag.toUpperCase(), { tokens, raw: r.inclusionLocations || "" });
  }

  await db.execute(
    "CREATE TABLE IF NOT EXISTS client_service_area (client_tag TEXT PRIMARY KEY, cities TEXT, raw TEXT, synced_at TEXT)",
  );
  const now = new Date().toISOString();
  await db.execute("DELETE FROM client_service_area");
  const entries = [...map.entries()];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    await db.batch(
      chunk.map(([tag, v]) => ({
        sql: "INSERT OR REPLACE INTO client_service_area (client_tag, cities, raw, synced_at) VALUES (?, ?, ?, ?)",
        args: [tag, JSON.stringify(v.tokens), v.raw, now],
      })),
      "write",
    );
  }
  invalidateServiceAreaCache();

  const withArea = entries.filter(([, v]) => v.tokens.length).length;
  const tags = entries.filter(([, v]) => v.tokens.length).map(([t]) => t).sort();
  return { count: entries.length, withArea, tags };
}
