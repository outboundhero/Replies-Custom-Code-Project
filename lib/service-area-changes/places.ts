/**
 * Service-area removals — the places a client takes out of its area, and the
 * exact rules for whether a lead sits in one of them.
 *
 * A place is entered as one of three kinds (the person entering it says which):
 *   city  — "Wheaton, IL"  (the state is required: there are 30 Springfields)
 *   state — "IL" / "Illinois"
 *   zip   — "60187"
 * Matching is exact (no radius, no "contains"): a lead is IN a removed place only
 * when every location signal it has agrees. Anything partial or contradictory is
 * "check" — shown for review, never removed unless someone ticks it.
 *
 * Pure (no I/O) so it can run in the browser for the entry preview and be tested
 * offline. ZIP facts (which city / state a ZIP belongs to) are passed in.
 */

export type PlaceType = "city" | "state" | "zip";

export interface Place {
  type: PlaceType;
  key: string;          // "state:IL" · "city:IL:wheaton" · "zip:60187"
  label: string;        // "Wheaton, IL" · "Illinois" · "60187"
  state?: string;       // 2-letter; for a ZIP, its state (from the ZIP table) when known
  city?: string;        // as entered (city) / the ZIP's city when known
  zip?: string;
  /** For a ZIP: how many ZIPs its city has (from the ZIP table). A lead with no ZIP
   *  in that city is only "needs checking" when the city has 1–2 ZIPs. */
  cityZipCount?: number;
}

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC", "washington dc": "DC", "washington d c": "DC",
};
// AP-style abbreviations ("Ill.", "Calif.") seen in scraped data, after the dots are dropped.
const STATE_ABBR: Record<string, string> = {
  ala: "AL", ariz: "AZ", ark: "AR", calif: "CA", cal: "CA", colo: "CO", conn: "CT", del: "DE", fla: "FL", ga: "GA",
  ill: "IL", ind: "IN", kan: "KS", kans: "KS", ky: "KY", la: "LA", md: "MD", mass: "MA", mich: "MI", minn: "MN",
  miss: "MS", mo: "MO", mont: "MT", neb: "NE", nebr: "NE", nev: "NV", okla: "OK", ore: "OR", oreg: "OR", pa: "PA",
  penn: "PA", tenn: "TN", tex: "TX", vt: "VT", va: "VA", wash: "WA", "w va": "WV", wis: "WI", wisc: "WI", wyo: "WY",
};
const STATE_CODES = new Set(Object.values(STATE_NAMES));
/** Values that mean "no state given" (never "a state that isn't removed"). */
const PLACEHOLDER = /^(n\/?a|na|none|null|nil|unknown|unk|tbd|tba|not available|not provided|no state|-+|\.+|\?+|0)$/i;
const CODE_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_NAMES).filter(([n]) => !n.startsWith("washington d")).map(([n, c]) => [c, n.replace(/\b\w/g, (x) => x.toUpperCase())]),
);

/** "IL" / "il" / "Illinois" / "Ill." → "IL"; anything else → "". */
export function usStateCode(raw: string | null | undefined): string {
  const t = String(raw ?? "").toLowerCase().replace(/[.]/g, "").replace(/[^a-z ]+/g, " ").trim().replace(/\s+/g, " ");
  if (!t) return "";
  if (t.length === 2) return STATE_CODES.has(t.toUpperCase()) ? t.toUpperCase() : "";
  return STATE_NAMES[t] ?? STATE_ABBR[t] ?? "";
}
export const stateName = (code: string) => CODE_TO_NAME[code] ?? code;

/** City name for comparison: case, accents, punctuation and Saint/Fort/Mount spellings folded. */
export function normCity(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/['’.]/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ")
    .replace(/\bsaint\b/g, "st").replace(/\bfort\b/g, "ft").replace(/\bmount\b/g, "mt");
}

/** A typed ZIP: exactly 5 digits (ZIP+4 trimmed). */
const zip5 = (raw: string | null | undefined): string => {
  const m = String(raw ?? "").trim().match(/^(\d{5})(?:-?\d{4})?$/);
  return m ? m[1] : "";
};
/** A lead's ZIP field: also a 4-digit value, a 0xxxx ZIP whose leading zero a spreadsheet dropped (New England). */
const leadZip = (raw: string | null | undefined): string => {
  const t = String(raw ?? "").trim();
  return zip5(t) || (/^\d{4}$/.test(t) ? `0${t}` : "");
};

// ── parsing what was typed ────────────────────────────────────────────────────

/** One city line → { city, state } or an error. Accepts "Wheaton, IL", "Wheaton IL", "Wheaton, Illinois". */
function parseCityLine(line: string): { city: string; state: string } | { error: string } {
  const t = line.trim().replace(/\s+/g, " ");
  const comma = t.lastIndexOf(",");
  if (comma > 0) {
    const city = t.slice(0, comma).trim(), st = usStateCode(t.slice(comma + 1));
    if (city && st && !/\d/.test(city)) return { city, state: st };
  }
  // Without a comma only a 2-letter code ends the line ("Wheaton IL") — a state
  // name could be part of the city ("Mount Washington", "Virginia Beach").
  const m = t.match(/^(.+?)\s+([A-Za-z]{2})$/);
  if (m && usStateCode(m[2]) && !/\d/.test(m[1])) return { city: m[1].replace(/,$/, "").trim(), state: usStateCode(m[2]) };
  return { error: `“${t}” needs its state — write it like “Wheaton, IL”.` };
}

/** Parse a pasted list of one kind of place. Cities: one per line. States / ZIPs: lines or commas. */
export function parsePlaces(type: PlaceType, text: string): { places: Place[]; errors: string[] } {
  const places: Place[] = [], errors: string[] = [];
  const seen = new Set<string>();
  const add = (p: Place) => { if (!seen.has(p.key)) { seen.add(p.key); places.push(p); } };
  const items = String(text || "").split(type === "city" ? /[\n;]+/ : /[\n;,]+/).map((s) => s.trim()).filter(Boolean);
  for (const item of items) {
    if (type === "state") {
      const st = usStateCode(item);
      if (!st) { errors.push(`“${item}” isn't a US state.`); continue; }
      add({ type, key: `state:${st}`, label: stateName(st), state: st });
    } else if (type === "zip") {
      const z = zip5(item);
      if (!z) { errors.push(`“${item}” isn't a 5-digit ZIP.`); continue; }
      add({ type, key: `zip:${z}`, label: z, zip: z });
    } else {
      const r = parseCityLine(item);
      if ("error" in r) { errors.push(r.error); continue; }
      const nc = normCity(r.city);
      if (!nc) { errors.push(`“${item}” isn't a city.`); continue; }
      add({ type, key: `city:${r.state}:${nc}`, label: `${r.city}, ${r.state}`, city: r.city, state: r.state });
    }
  }
  return { places, errors };
}

// ── a lead's location ─────────────────────────────────────────────────────────

/** City / state / ZIP from a free-text address ("7741 W 87th Pl, Bridgeview, IL 60455", "Wheaton, Illinois, United States"). */
export function parseAddress(raw: string | null | undefined): { city?: string; state?: string; zip?: string } {
  const a = String(raw ?? "").trim();
  if (!a || /no address/i.test(a)) return {};
  const parts = a.split(",").map((p) => p.trim()).filter(Boolean);
  while (parts.length && /^(usa|us|u\.?s\.?a?\.?|united states( of america)?)$/i.test(parts[parts.length - 1])) parts.pop();
  if (!parts.length) return {};
  const out: { city?: string; state?: string; zip?: string } = {};
  let i = parts.length - 1;
  let tail = parts[i];
  const zm = /\bbox\s*#?\s*\d+$/i.test(tail) ? null : tail.match(/^(.*?)\s*\b(\d{5})(?:-\d{4})?$/);
  if (zm) {
    out.zip = zm[2];
    tail = zm[1].trim();
    if (!tail) { i -= 1; tail = parts[i] ?? ""; }
  }
  const whole = usStateCode(tail);
  if (whole) {
    out.state = whole;
    const c = parts[i - 1];
    if (c && !/\d/.test(c)) out.city = c;
    return out;
  }
  // "Wheaton IL" / "123 Main St Wheaton IL" in one part — the state is the last
  // word, written as an upper-case code (so "… drop-off in" isn't Indiana).
  const sm = tail.match(/^(.*?)\s+([A-Z]{2})$/);
  if (sm && usStateCode(sm[2])) {
    out.state = usStateCode(sm[2]);
    const rest = sm[1].trim();
    if (rest && !/\d/.test(rest)) out.city = rest;
  }
  return out;
}

/** Every location signal a lead has, normalised for matching. */
export interface Signals { cities: string[]; states: string[]; zips: string[] }

/** What the review screen shows for a lead's location. */
export interface LocationView { city: string | null; state: string | null; zip: string | null; address: string | null }

export interface LocationInput {
  city?: string | null; state?: string | null; zip?: string | null; address?: string | null;
  /** Location the lead wrote in its reply (Reply Router's audit) — counted like any other signal. */
  replyCity?: string | null; replyState?: string | null;
}

export function readVar(vars: Array<{ name?: string; value?: string }> | null | undefined, ...names: string[]): string | null {
  if (!Array.isArray(vars)) return null;
  const want = new Set(names.map((n) => n.toLowerCase()));
  for (const v of vars) {
    if (v && typeof v.name === "string" && want.has(v.name.toLowerCase().trim())) {
      const val = v.value == null ? "" : String(v.value).trim();
      if (val) return val;
    }
  }
  return null;
}

/** A Bison lead's (or a sequence-finished row's) custom variables → location input. */
export function inputFromCustomVars(vars: Array<{ name?: string; value?: string }> | null | undefined): LocationInput {
  return {
    city: readVar(vars, "city"),
    state: readVar(vars, "state"),
    zip: readVar(vars, "zip", "zip code", "zipcode", "postal code", "postcode", "zip_code"),
    address: readVar(vars, "address", "street address", "company address"),
  };
}

export function signalsOf(input: LocationInput): { signals: Signals; view: LocationView } {
  const addr = parseAddress(input.address);
  const cities = new Set<string>(), states = new Set<string>(), zips = new Set<string>();
  const addCity = (c: string | null | undefined) => { const n = normCity(c); if (n) cities.add(n); };
  const addState = (s: string | null | undefined) => {
    const raw = String(s ?? "").trim();
    if (!raw || PLACEHOLDER.test(raw)) return;
    const code = usStateCode(raw);
    // Something that isn't a US state (a province, junk) still counts as "a state
    // we know, and it isn't a removed one" — never as "no state".
    states.add(code || `?${raw.toLowerCase()}`);
  };
  addCity(input.city); addCity(addr.city); addCity(input.replyCity);
  addState(input.state); addState(addr.state); addState(input.replyState);
  const z1 = leadZip(input.zip); if (z1) zips.add(z1);
  if (addr.zip) zips.add(addr.zip);
  const address = String(input.address ?? "").trim();
  return {
    signals: { cities: [...cities], states: [...states], zips: [...zips] },
    view: {
      city: (input.city || addr.city || input.replyCity || null)?.toString().trim() || null,
      state: usStateCode(input.state) || addr.state || usStateCode(input.replyState) || (input.state ? String(input.state).trim() : null) || null,
      zip: z1 || addr.zip || null,
      address: address && !/no address/i.test(address) ? address : null,
    },
  };
}

export function mergeSignals(a: Signals, b: Signals): Signals {
  const u = (x: string[], y: string[]) => [...new Set([...x, ...y])];
  return { cities: u(a.cities, b.cities), states: u(a.states, b.states), zips: u(a.zips, b.zips) };
}

// ── the decision ──────────────────────────────────────────────────────────────

export type LeadClass = "match" | "check" | "noloc" | "out";
export interface Verdict { cls: LeadClass; place: string | null; reason: string }

/** ZIP → its city and state (from the US ZIP table); missing ZIPs are simply unknown. */
export type ZipFacts = Map<string, { city: string; state: string }>;
/** City (normCity) → the states that have a city by that name (from the US ZIP table). A city not in it is simply unknown. */
export type CityStates = Map<string, Set<string>>;

const RANK: Record<LeadClass, number> = { match: 3, check: 2, noloc: 1, out: 0 };
const list = (xs: string[]) => xs.map((s) => (s.startsWith("?") ? s.slice(1) : s)).join(" / ");

/**
 * Is this lead in one of the removed places?
 *   match — every signal it has puts it there → ticked for removal by default
 *   check — some signal points there but it's partial or contradicts another → shown, not ticked
 *   noloc — no city, state or ZIP at all → shown, not ticked
 *   out   — not in any removed place
 */
export function classify(sig: Signals, places: Place[], zipFacts: ZipFacts = new Map(), cityStates: CityStates = new Map()): Verdict {
  if (!sig.cities.length && !sig.states.length && !sig.zips.length) return { cls: "noloc", place: null, reason: "No city, state or ZIP on this lead" };
  // US states we can read; "unclear" = a state value we can't (a province, a typo).
  const known = sig.states.filter((s) => !s.startsWith("?"));
  const unclear = known.length < sig.states.length;
  // What each known ZIP says: its own city and state count as signals too.
  const zipF = sig.zips.map((z) => zipFacts.get(z)).filter((f): f is { city: string; state: string } => !!f);
  const states = [...new Set([...known, ...zipF.map((f) => f.state)])];

  let best: Verdict = { cls: "out", place: null, reason: "" };
  const consider = (v: Verdict) => { if (RANK[v.cls] > RANK[best.cls]) best = v; };

  for (const p of places) {
    if (p.type === "state") {
      const S = p.state!;
      // The lead's cities against the state (a city we don't know can't disagree).
      const inS = sig.cities.filter((c) => cityStates.get(c)?.has(S));
      const notInS = sig.cities.filter((c) => { const st = cityStates.get(c); return !!st && !st.has(S); });
      if (!states.length) {
        // Only a city: listed (not ticked) when it's a city in the removed state.
        if (inS.length) consider({ cls: "check", place: p.key, reason: `${unclear ? `Its state (${list(sig.states)}) isn't clear` : "No state on this lead"} — its city, ${inS.join(" / ")}, is a city in ${S}` });
        continue;
      }
      if (states.every((s) => s === S) && !unclear) {
        if (notInS.length) consider({ cls: "check", place: p.key, reason: `State is ${S}, but its city (${notInS.join(" / ")}) isn't a city in ${S}` });
        else consider({ cls: "match", place: p.key, reason: `State is ${S}` });
      } else if (states.includes(S)) consider({ cls: "check", place: p.key, reason: `Its state is given as ${list([...states, ...sig.states.filter((x) => x.startsWith("?"))])} in different places` });
    } else if (p.type === "city") {
      const C = normCity(p.city), S = p.state!;
      if (sig.cities.includes(C)) {
        const otherZip = zipF.find((f) => normCity(f.city) !== C || f.state !== S);
        if (sig.cities.length > 1) consider({ cls: "check", place: p.key, reason: `Its city is given as both ${p.city} and another place` });
        else if (otherZip) consider({ cls: "check", place: p.key, reason: `City is ${p.city}, but its ZIP is in ${otherZip.city}, ${otherZip.state}` });
        else if (!states.length) consider({ cls: "check", place: p.key, reason: `City is ${p.city}, but its state isn't ${unclear ? "clear" : "known"}` });
        else if (states.every((s) => s === S) && !unclear) consider({ cls: "match", place: p.key, reason: `City is ${p.city}, ${S}` });
        else if (states.includes(S) || unclear) consider({ cls: "check", place: p.key, reason: `City is ${p.city}, but its state is given as ${list(sig.states.length ? sig.states : states)}` });
        // same-named city in another state → not this place
      } else if (!sig.cities.length && zipF.some((f) => f.state === S && normCity(f.city) === C)) {
        consider({ cls: "check", place: p.key, reason: `No city on this lead — its ZIP is in ${p.city}, ${S}` });
      }
      // A lead whose only location is the state isn't tied to one city — not listed.
    } else {
      const Z = p.zip!;
      if (sig.zips.includes(Z)) {
        const cityOff = p.city && sig.cities.length && !sig.cities.includes(normCity(p.city));
        if (sig.zips.length > 1) consider({ cls: "check", place: p.key, reason: `Its ZIP is given as both ${Z} and another` });
        else if (sig.cities.length > 1) consider({ cls: "check", place: p.key, reason: `ZIP is ${Z}, but its city is given as ${sig.cities.join(" and ")}` });
        else if (p.state ? states.some((s) => s !== p.state) : known.length > 1) consider({ cls: "check", place: p.key, reason: `ZIP is ${Z}, but its state is given as ${list(states)}` });
        else if (unclear) consider({ cls: "check", place: p.key, reason: `ZIP is ${Z}, but its state is given as ${list(sig.states)}` });
        else if (cityOff) consider({ cls: "check", place: p.key, reason: `ZIP is ${Z} (${p.city}), but its city is given as ${sig.cities.join(" / ")}` });
        else consider({ cls: "match", place: p.key, reason: `ZIP is ${Z}` });
      } else if (!sig.zips.length && p.city && p.state && (p.cityZipCount ?? 99) <= 2) {
        // No ZIP on the lead, in a city with only 1–2 ZIPs: it may well be in this one.
        // (In a city with many ZIPs — Austin has dozens — that's no real sign, so it isn't listed.)
        const inZipCity = sig.cities.includes(normCity(p.city)) && (!states.length || states.includes(p.state));
        if (inZipCity) consider({ cls: "check", place: p.key, reason: `No ZIP on this lead — it's in ${p.city}, ${p.state}, which has ZIP ${Z}${p.cityZipCount === 2 ? " and one other" : ""}` });
      }
    }
  }
  return best;
}

/** What to type into Bison's lead search to find a place's leads quickly (results are re-checked exactly). */
export function searchTermFor(p: Place): string {
  if (p.type === "zip") return p.zip!;
  if (p.type === "state") return stateName(p.state!);
  // The longest word of the city finds it whatever "St." / "Saint" spelling a lead uses.
  const words = String(p.city).replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !/^(saint|fort|mount)$/i.test(w));
  return words.sort((a, b) => b.length - a.length)[0] || String(p.city);
}

/** The default removal day: the 6th calendar day counting the notice day as day 1 (notice Oct 1 → Oct 6), from 00:00 Pacific. */
export function removalDate(noticeDate: string): string {
  const [y, m, d] = noticeDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 5));
  return t.toISOString().slice(0, 10);
}

/** Days from one YYYY-MM-DD date to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export const MAX_REMOVAL_DAYS = 90;

/**
 * Why a chosen removal day can't be used ("" when it can): a real date, not in
 * the past (Pacific), not before the notice, at most 90 days after it. Today is
 * allowed — the removal then runs as soon as the list is approved.
 */
export function removalDateProblem(date: string, noticeDate: string | null, today: string): string {
  if (!isIsoDate(date)) return "Pick the removal day.";
  if (date < today) return "The removal day can't be in the past.";
  if (noticeDate && date < noticeDate) return "The removal day can't be before the notice date.";
  if (noticeDate && daysBetween(noticeDate, date) > MAX_REMOVAL_DAYS) return `The removal day is more than ${MAX_REMOVAL_DAYS} days after the notice — check it.`;
  return "";
}

const LA = "America/Los_Angeles";
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: LA, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** Today's date in Pacific time, YYYY-MM-DD. */
export function pacificToday(now: Date = new Date()): string {
  return ymd(now);
}

/** The instant 00:00 Pacific begins on a YYYY-MM-DD date (PST or PDT). */
export function pacificMidnight(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  for (const offset of [7, 8]) {
    const t = new Date(Date.UTC(y, m - 1, d, offset));
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: LA, hour: "numeric", hourCycle: "h23" }).format(t));
    if (ymd(t) === date && hour === 0) return t;
  }
  return new Date(Date.UTC(y, m - 1, d, 8));
}

/** A real calendar date written YYYY-MM-DD (so 2026-02-31 isn't one). */
export const isIsoDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
