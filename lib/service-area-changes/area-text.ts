/**
 * The places in a client's service-area text (the Onboarding Form's "Inclusion
 * Locations" cell), and what changed between two versions of it.
 *
 * The cell is free text in many shapes: "texas: alvin, angleton, …", one ZIP per
 * line, ZIP / city / state tables (markdown or space-aligned), "Schaumburg
 * 60159-60168", "In Alabama, counties: Madison, …", "All of Las Vegas and
 * Henderson (Las Vegas Valley)", "all cities EXCEPT Cincinnati, OH". Each version
 * is read into a set of places (ZIPs, cities with their state when one is given,
 * counties, states — and the places it excludes) and two versions are compared
 * place by place, so re-ordering, spacing, letter case, a state written on or
 * left off a city, or splitting one comma-less run into separate names never
 * counts as a change. Pure — no I/O.
 */
import { normCity, stateName, usStateCode } from "@/lib/service-area-changes/places";

export type AreaKind = "zip" | "state" | "city" | "county";
export interface AreaItem {
  key: string; kind: AreaKind; label: string; state: string | null; zip?: string;
  /** Named as an exception ("except Cincinnati") — a place the client does NOT serve. */
  excluded?: boolean;
}

// Words that label a list rather than name a place.
const NOISE = /^(?:cities|city|counties|county|towns?|zip ?codes?|zips?|zip code|states?|areas?|and|or|the|including|includes?|include|all|etc|n ?a|none|tbd|surrounding areas?|nearby|metro|region|plus)$/;
const MAX_RANGE = 200; // "60159-60168" is expanded; a wider span is read as two ZIPs
const EXCEPT = /\b(?:except(?:\s+for)?|excluding|exclude|not including|other than|but not)\b/i;

/** A full state name ("Texas", "new york"). */
function fullState(raw: string): string {
  const code = usStateCode(raw);
  return code && raw.trim().length > 2 && normCity(stateName(code)) === normCity(raw) ? code : "";
}
/** A 2-letter state code; in any case when it stands alone as a list item, else only in capitals. */
function codeState(raw: string, anyCase: boolean): string {
  const t = raw.trim().replace(/\.$/, "");
  if (t.length !== 2 || !(anyCase || t === t.toUpperCase())) return "";
  return usStateCode(t);
}

/** A state named inside a list label ("In Alabama, counties" → AL; "TX" → TX). */
function stateInLabel(label: string): string {
  const whole = fullState(label) || codeState(label, false);
  if (whole) return whole;
  const words = label.replace(/[^A-Za-z ]+/g, " ").split(/\s+/).filter(Boolean);
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const w = words.slice(i, i + n).join(" ");
      const s = n === 1 && w.length === 2 ? codeState(w, false) : fullState(w);
      if (s) return s;
    }
  }
  return "";
}

const title = (s: string) => (/[A-Z]/.test(s) ? s : s.replace(/\b[a-z]/g, (c) => c.toUpperCase()));
const stripMarker = (s: string) => s.replace(/^\s*(?:\d{1,3}[.)]|[-*•·–])\s+/, "");

/** ZIP ranges written out ("60159-60168" / "60159 - 60168" → each ZIP), before anything is split on dashes. */
function expandRanges(s: string): string {
  return s.replace(/\b(\d{5})\s*[-–]\s*(\d{5})\b/g, (m, a: string, b: string) => {
    const x = Number(a), y = Number(b);
    if (!(y > x && y - x <= MAX_RANGE)) return `${a}, ${b}`;
    const out: string[] = [];
    for (let z = x; z <= y; z++) out.push(String(z).padStart(5, "0"));
    return out.join(", ");
  });
}

/** Every place a service-area text names, by key (the same place written twice is one place). */
export function areaItems(text: string | null | undefined): Map<string, AreaItem> {
  const out = new Map<string, AreaItem>();
  let excluded = false; // while reading an "except …" part
  const keyOf = (k: string) => (excluded ? `ex:${k}` : k);
  const add = (it: AreaItem) => { const key = keyOf(it.key); if (!out.has(key)) out.set(key, { ...it, key, ...(excluded ? { excluded: true } : {}) }); return key; };
  const addZip = (z: string) => add({ key: `zip:${z}`, kind: "zip", label: z, state: null, zip: z });
  const addState = (s: string) => add({ key: `state:${s}`, kind: "state", label: stateName(s), state: s });
  const placeItem = (p: string, state: string | null, k: "city" | "county"): AreaItem =>
    ({ key: `${k}:${state ?? ""}:${normCity(p)}`, kind: k, label: `${title(p.replace(/\s+/g, " "))}${k === "county" ? " County" : ""}${state ? `, ${state}` : ""}`, state });

  /** One list ("a, b, c") — `ctx` is the state of the block it's in. */
  const readList = (items: string[], ctx: string | null, kind: "city" | "county") => {
    const cleaned = items.map((x) => stripMarker(x).replace(/\([^)]*\)/g, " ").replace(/[“”"]/g, " ").trim());
    const named = cleaned.map((x) => x.replace(/\b\d{5}(?:-\d{4})?\b/g, " ").trim()).filter(Boolean);
    // Full state names are states only in a list of nothing but states ("Ohio, Kentucky");
    // among cities ("Manhattan, Brooklyn, New York") a state's name is a city.
    // ("New York, NY" / "Washington, DC" — a code right after a state's name — are cities.)
    const allStates = !ctx && named.length > 0 && named.every((x) => fullState(x) || codeState(x, true))
      && !named.some((x, i) => i > 0 && codeState(x, true) && fullState(named[i - 1]));
    let last: { key: string; name: string; k: "city" | "county" } | null = null;
    for (const piece of cleaned) {
      piece.replace(/\b\d{5}(?:-\d{4})?\b/g, (m) => { addZip(m.slice(0, 5)); return " "; });
      let p = piece.replace(/\b\d{5}(?:-\d{4})?\b/g, " ").replace(/\s+/g, " ").trim();
      p = p.replace(/^(?:all of|all|in|the|city of|town of|village of|cities of|parts of|greater)\s+/i, "").replace(/\s+(?:area|areas|metro|metro area)$/i, "");
      if (!p) { continue; }
      // A lone 2-letter code: the state of the place before it ("Houston, TX"), or a state.
      const code = codeState(p, true);
      if (code) {
        if (last && last.k === "city") {
          out.delete(last.key);
          add(placeItem(last.name, code, "city"));
        } else if (!(ctx && code === ctx)) addState(code);
        last = null;
        continue;
      }
      if (allStates && fullState(p)) { addState(fullState(p)); last = null; continue; }
      let k: "city" | "county" = kind;
      if (/\s+(?:county|counties|parish)$/i.test(p)) { k = "county"; p = p.replace(/\s+(?:county|counties|parish)$/i, ""); }
      const n = normCity(p);
      if (!n || NOISE.test(n) || /^\d+$/.test(n) || n.length < 2) { last = null; continue; }
      // "Houston TX" in one item (the code in capitals).
      const tail = k === "city" ? p.match(/^(.+?)[\s,]+([A-Z]{2})$/) : null;
      const ts = tail ? codeState(tail[2], false) : "";
      if (tail && ts) { add(placeItem(tail[1], ts, "city")); last = null; continue; }
      const key = add(placeItem(p, ctx, k));
      last = { key, name: p, k };
    }
  };

  let ctxState: string | null = null;
  const lines = String(text ?? "").split(/\r?\n/);
  let tableCols: { zip: number; city: number; state: number } | null = null;
  const cellsOf = (line: string) => line.split("|").map((c) => c.trim()).filter((c, i, a) => !(c === "" && (i === 0 || i === a.length - 1)));
  const isSep = (line: string) => line.trim().startsWith("|") && cellsOf(line).every((c) => /^[-: ]*$/.test(c));

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    excluded = false;
    if (!line) { ctxState = null; tableCols = null; continue; } // a state label covers its own block

    // Markdown table: the row right above |---| is the header.
    if (line.startsWith("|")) {
      if (isSep(line)) continue;
      const cells = cellsOf(line);
      if (li + 1 < lines.length && isSep(lines[li + 1])) {
        const find = (re: RegExp) => cells.findIndex((c) => re.test(c));
        tableCols = { zip: find(/zip|postal/i), city: find(/city|town|place|location/i), state: find(/state/i) };
        continue;
      }
      const cols = tableCols ?? { zip: cells.findIndex((c) => /^\d{5}/.test(c)), city: -1, state: -1 };
      if (cols.zip >= 0) (cells[cols.zip] ?? "").replace(/\b\d{5}\b/g, (m) => { addZip(m); return m; });
      const st = cols.state >= 0 ? (fullState(cells[cols.state] ?? "") || codeState(cells[cols.state] ?? "", true) || ctxState) : ctxState;
      const city = cols.city >= 0 ? cells[cols.city] : cells.find((c, i) => i !== cols.zip && !/\d/.test(c) && !fullState(c) && !codeState(c, true));
      if (city) readList([city], st || null, "city");
      continue;
    }
    tableCols = null;
    // Space-aligned table row: 77083        HOUSTON        HARRIS
    const aligned = line.match(/^(\d{5})(?:\t|\s{2,})(.+)$/);
    if (aligned) {
      addZip(aligned[1]);
      const cols = aligned[2].split(/\t|\s{2,}/).map((c) => c.trim()).filter(Boolean);
      if (cols[0] && !/\d/.test(cols[0])) readList([cols[0]], ctxState, "city");
      continue;
    }
    if (/^zip\s*code\b/i.test(line) && !/\d{5}/.test(line)) continue; // a table's header line

    // "texas: a, b" · "In Alabama, counties: x, y" · "Cities: …" · "Chicago: Norridge 60656, …"
    let rest = expandRanges(stripMarker(line)), kind: "city" | "county" = "city";
    const pre = rest.match(/^([^:\d]{1,48}):(?!\/\/)\s*(.*)$/);
    if (pre) {
      const label = pre[1].trim();
      const st = stateInLabel(label);
      if (st) ctxState = st;
      if (/count(?:y|ies)|parish/i.test(label)) kind = "county";
      // A label that is a place itself ("Chicago: Norridge, …") is a place too.
      else if (!st && !EXCEPT.test(label) && !/^(?:cities|city|towns?|zips?|zip codes?|areas?|locations?|service areas?|includes?|including|neighbou?rhoods?|notes?)$/i.test(label)) readList([label], ctxState, "city");
      rest = EXCEPT.test(label) ? `except ${pre[2]}` : pre[2];
    }
    // "… except a, b" — the rest of the line (to a closing bracket) is what's excluded.
    const parts = rest.split(EXCEPT);
    // A closed (bracketed note) is dropped; an unclosed "(" just ends an item.
    const splitList = (s: string) => s.replace(/\([^)]*\)/g, " ").split(/[,;|/()]|\s+(?:and|&)\s+|\s+[-–]\s+/i);
    readList(splitList(parts[0]), ctxState, kind);
    for (const ex of parts.slice(1)) {
      const [inside, after = ""] = ex.split(/\)/, 2);
      excluded = true;
      readList(splitList(inside), ctxState, kind);
      excluded = false;
      if (after.trim()) readList(splitList(after), ctxState, kind);
    }
  }
  return out;
}

export interface AreaDiff { removed: AreaItem[]; added: AreaItem[] }

/**
 * What a new version took out and put in. Not a change: a name split into
 * several (or several joined into one) with exactly the same words —
 * "Carmel Fishers Greenwood" → "Carmel, Fishers, Greenwood" — and a city that
 * only gained or lost its state ("Houston" ↔ "Houston, TX"). A place that is
 * newly excluded ("except Gary") counts as taken out; one no longer excluded,
 * as put back in.
 */
export function diffAreaText(before: string | null | undefined, after: string | null | undefined): AreaDiff {
  const a = areaItems(before), b = areaItems(after);
  let removed = [...a.values()].filter((x) => !b.has(x.key));
  let added = [...b.values()].filter((x) => !a.has(x.key));
  const drop = new Set<AreaItem>();
  // A state written on / left off a city or county.
  const bare = (x: AreaItem) => `${x.excluded ? "ex:" : ""}${x.kind}:${x.key.split(":").slice(-1)[0]}`;
  for (const r of removed) {
    if (r.kind !== "city" && r.kind !== "county") continue;
    const m = added.find((x) => !drop.has(x) && bare(x) === bare(r) && (!x.state || !r.state));
    if (m) { drop.add(r); drop.add(m); }
  }
  // Re-split / joined names.
  const words = (x: AreaItem) => new Set(normCity(x.label.replace(/,\s*[A-Z]{2}$/, "").replace(/ County$/, "")).split(" "));
  const sameWords = (one: AreaItem, many: AreaItem[]) => {
    if (many.length < 2) return false;
    const w = words(one), u = new Set(many.flatMap((m) => [...words(m)]));
    return w.size === u.size && [...w].every((x) => u.has(x));
  };
  const compatible = (x: AreaItem, y: AreaItem) => x.kind === y.kind && !!x.excluded === !!y.excluded && (x.state === y.state || !x.state || !y.state);
  for (const r of removed) {
    if (r.kind === "zip" || r.kind === "state" || drop.has(r)) continue;
    const parts = added.filter((x) => !drop.has(x) && compatible(x, r) && [...words(x)].every((w) => words(r).has(w)));
    if (sameWords(r, parts)) { drop.add(r); parts.forEach((p) => drop.add(p)); }
  }
  for (const n of added) {
    if (n.kind === "zip" || n.kind === "state" || drop.has(n)) continue;
    const parts = removed.filter((x) => !drop.has(x) && compatible(x, n) && [...words(x)].every((w) => words(n).has(w)));
    if (sameWords(n, parts)) { drop.add(n); parts.forEach((p) => drop.add(p)); }
  }
  removed = removed.filter((x) => !drop.has(x));
  added = added.filter((x) => !drop.has(x));
  // Exclusions flip sides: newly excluded = taken out; no longer excluded = back in.
  const relabel = (x: AreaItem, note: string): AreaItem => ({ ...x, label: `${x.label} (${note})` });
  const out: AreaDiff = {
    removed: [...removed.filter((x) => !x.excluded), ...added.filter((x) => x.excluded).map((x) => relabel(x, "now excluded"))],
    added: [...added.filter((x) => !x.excluded), ...removed.filter((x) => x.excluded).map((x) => relabel(x, "no longer excluded"))],
  };
  const order = (x: AreaItem, y: AreaItem) => x.kind.localeCompare(y.kind) || x.label.localeCompare(y.label);
  return { removed: out.removed.sort(order), added: out.added.sort(order) };
}
