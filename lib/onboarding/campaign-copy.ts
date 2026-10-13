/**
 * Email copy for a new client's campaigns (onboarding step 2) — pure, no I/O.
 *
 * A new client's campaigns are copies of a MASTER client's campaigns with one
 * kind of change: the master's place names (area name, city, state, state
 * abbreviation) become the new client's. Everything else is carried over
 * character for character:
 *   • spintax          {Hey|Hi}, nested as deep as it goes
 *   • variables        {CITY} {QUESTION} {FIRST_NAME} {SENDER_FULL_NAME} …
 *                      (a {CAPS_NAME} with no "|" inside — never touched)
 *   • subjects         they only ever carry {CITY}, never a place name, so
 *                      they are not edited at all
 *
 * The swap is deliberately narrow and the check after it deliberately wide:
 *   swap   exact spelling, whole words; the state abbreviation only where it
 *          sits beside the city or the state name ("Winnipeg, MB",
 *          "{MB|Manitoba}") — never a stray "OK" or "IN" in a sentence.
 *   check  nothing of the master may be left in ANY spelling (other case,
 *          "St Louis" for "St. Louis", inside a tag or an entity), the
 *          spintax and variables must be unchanged, and nothing that looks
 *          like the master's address, phone or website may ride along.
 * Any failed check is a problem that blocks creating the campaigns — a master
 * the rules can't handle is refused rather than guessed at.
 */

export interface Place {
  /** How the area is named in the copy, e.g. "Winnipeg Area", "Central Alabama". */
  area: string;
  city: string;
  /** Full state / province name, e.g. "Manitoba". */
  state: string;
  /** Its abbreviation, e.g. "MB". */
  abbr: string;
}

export interface CopyStep {
  order: number;
  email_subject: string;
  /** HTML (line breaks are <br>). */
  email_body: string;
}

export interface CopyChange { order: number; before: string; after: string }
export interface LocalizeResult<T extends CopyStep> {
  steps: T[];
  /** Lines that changed, in plain text, for the preview. */
  changes: CopyChange[];
  replacements: number;
  /** Reasons the result must not be used (empty = safe). */
  problems: string[];
}

const VARIABLE = /\{[A-Z][A-Z0-9_]*\}/g;
const W = "[A-Za-z0-9]";
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** HTML body → the text a person reads in the editor (for previews). */
export const bodyText = (html: string) =>
  html.replace(/<br\s*\/?>/gi, "\n").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** Everything a body says, however it is encoded: tags opened up, entities and odd spaces resolved. */
function plain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/[  -​ ]/g, " ");
}
/** Lower-case words only — "St. Louis", "ST LOUIS" and "St&nbsp;Louis" all read the same. */
const wordsOf = (text: string) => plain(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** The variables a text uses, in order (duplicates kept). */
export function variablesIn(text: string): string[] {
  return text.match(VARIABLE) ?? [];
}

/** Only the structural characters — unchanged structure means unchanged spintax. */
function skeleton(text: string): string {
  return text.replace(VARIABLE, "V").replace(/[^{}|]/g, "");
}

/** The area name used when none is given: "Winnipeg" → "Winnipeg Area". */
export const defaultArea = (city: string) => (city.trim() ? `${city.trim()} Area` : "");

/** Why a place can't be written into copy (empty = fine). */
export function placeProblems(p: Place, who: string): string[] {
  const out: string[] = [];
  const fields: [string, string | undefined, boolean][] = [
    ["area name", p.area, false], ["city", p.city, true], ["state", p.state, true], ["state abbreviation", p.abbr, true],
  ];
  for (const [label, raw, required] of fields) {
    const v = (raw ?? "").trim();
    if (!v) { if (required) out.push(`${who}: the ${label} is missing.`); continue; }
    if (/[{}|<>\r\n]/.test(v)) out.push(`${who}: the ${label} can't contain { } | < > or line breaks.`);
  }
  if (p.abbr.trim() && !/^[A-Z]{2,3}$/.test(p.abbr.trim())) out.push(`${who}: the state abbreviation should be 2–3 capital letters (e.g. CA).`);
  return out;
}

const same = (a: string, b: string) => wordsOf(a).join(" ") === wordsOf(b).join(" ");

/** A master whose own names can't be told apart can't be swapped safely. */
function masterProblems(m: Place): string[] {
  const out: string[] = [];
  if (same(m.city, m.state)) out.push(`Master: its city and state are the same name (“${m.city}”) — they can't be told apart in the copy. Use another master.`);
  if (m.area.trim() && same(m.area, m.state)) out.push(`Master: its area name and state are the same (“${m.state}”) — they can't be told apart in the copy. Use another master.`);
  return out;
}

type Kind = "area" | "city" | "state" | "abbr";

/**
 * One pass over the master's exact spellings. Names match as whole words; the
 * abbreviation only beside the city ("Winnipeg, MB", "Winnipeg, {MB") or
 * paired with the state in a choice ("MB|Manitoba", "Manitoba|MB").
 */
function swapRegex(m: Place): { re: RegExp; kindOf: (hit: string) => Kind } {
  const area = m.area.trim() && !same(m.area, m.city) ? escapeHtml(m.area.trim()) : "";
  const city = escapeHtml(m.city.trim());
  const state = escapeHtml(m.state.trim());
  const abbr = m.abbr.trim();
  const names = [area, city, state].filter(Boolean).sort((a, b) => b.length - a.length)
    .map((n) => `(?<!${W})${escapeRegExp(n)}(?!${W})`);
  const c = escapeRegExp(city), s = escapeRegExp(state), a = escapeRegExp(abbr);
  const beside = [
    `(?<=${c},\\s{0,2}\\{?)${a}(?!${W})`,
    `(?<!${W})${a}(?=\\|${s}(?!${W}))`,
    `(?<=(?<!${W})${s}\\|)${a}(?!${W})`,
  ];
  return {
    re: new RegExp([...names, ...beside].join("|"), "g"),
    kindOf: (hit) => (area && hit === area ? "area" : hit === city ? "city" : hit === state ? "state" : "abbr"),
  };
}

/** Does `needle` (a word sequence) occur in `hay` at a spot that isn't masked? */
function hasSequence(hay: string[], needle: string[], masked: boolean[]): boolean {
  if (!needle.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j] || masked[i + j]) continue outer;
    return true;
  }
  return false;
}
function maskSequence(hay: string[], needle: string[], masked: boolean[]): void {
  if (!needle.length) return;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    for (let j = 0; j < needle.length; j++) masked[i + j] = true;
  }
}

/** Which of the master's names are still in `text`, in any spelling — once the new client's own names are set aside. */
function mastersLeft(text: string, master: Place, target: Place | null): string[] {
  const hay = wordsOf(text);
  const masked = new Array<boolean>(hay.length).fill(false);
  const mine = target ? [target.area, target.city, target.state] : [];
  for (const n of mine) maskSequence(hay, wordsOf(n), masked);
  const left: string[] = [];
  for (const n of [master.area, master.city, master.state]) {
    if (!n.trim() || mine.some((t) => same(t, n))) continue;
    if (hasSequence(hay, wordsOf(n), masked)) left.push(n.trim());
  }
  // The abbreviation is judged as written (capitals, whole word) — "in" is not "IN".
  const abbr = master.abbr.trim();
  if (abbr && abbr !== target?.abbr.trim()) {
    // The new client's names may contain those letters ("LA Metro") — set them aside first.
    let rest = plain(text);
    for (const n of mine) if (n.trim()) rest = rest.split(n.trim()).join(" ");
    if (new RegExp(`(?<!${W})${escapeRegExp(abbr)}(?!${W})`).test(rest)) left.push(abbr);
  }
  return left;
}

// Things that belong to the master and would ride along into the new client's emails.
const RIDE_ALONG: [RegExp, string][] = [
  [/\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/, "a phone number"],
  [/\b\d{5}(?:-\d{4})?\b|\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/, "a ZIP / postal code"],
  [/\b\d{2,6}\s+[A-Z][a-z]+/, "a street address"],
  [/https?:\/\/|\bwww\.|[\w.-]+@[\w-]+\.[a-z]{2,}|\b[a-z0-9-]+\.(?:com|net|org|co|io|info|us|ca|biz)\b/i, "a web or email address"],
];

/**
 * The master's steps rewritten for a new client. Subjects are returned exactly
 * as they are; only bodies change, and only where a master place name stood.
 */
export function localizeSteps<T extends CopyStep>(steps: T[], master: Place, target: Place): LocalizeResult<T> {
  const problems = [...placeProblems(master, "Master"), ...placeProblems(target, "New client")];
  if (!problems.length) problems.push(...masterProblems(master));
  const ordered = [...steps].sort((a, b) => a.order - b.order);
  if (problems.length) return { steps: ordered, changes: [], replacements: 0, problems };

  const area = target.area.trim() || defaultArea(target.city);
  const to: Record<Kind, string> = {
    area: escapeHtml(area), city: escapeHtml(target.city.trim()), state: escapeHtml(target.state.trim()), abbr: target.abbr.trim(),
  };
  const { re, kindOf } = swapRegex(master);
  const counts: Record<Kind, number> = { area: 0, city: 0, state: 0, abbr: 0 };
  const out: T[] = [];
  const changes: CopyChange[] = [];
  const note = (p: string) => { if (!problems.includes(p)) problems.push(p); };

  for (const step of ordered) {
    // Subjects are never edited, so a place name in one can't be localised.
    if (mastersLeft(step.email_subject, master, null).length) {
      note(`Email ${step.order}: the subject contains one of the master's place names — subjects aren't edited, so this master can't be used as it is.`);
    }

    // Split into protected pieces ({VARIABLES} and <tags>) and free text; only free text is swapped.
    const text = step.email_body.split(/(\{[A-Z][A-Z0-9_]*\}|<[^>]+>)/g).map((piece, i) => {
      if (i % 2 === 1) return piece;
      return piece.replace(re, (hit: string, offset: number, whole: string) => {
        const kind = kindOf(hit);
        if (kind === "state") {
          // "Kansas City", "West Virginia": the state's name inside a longer name is not the state.
          const before = whole.slice(0, offset), after = whole.slice(offset + hit.length);
          if (/[A-Z][A-Za-z.'’-]*\s+$/.test(before) || /^\s+[A-Z]/.test(after)) {
            note(`Email ${step.order}: “${master.state}” appears inside a longer name (“${(before.match(/\S+\s+$/)?.[0] ?? "") + hit + (after.match(/^\s+\S+/)?.[0] ?? "")}”) — can't tell if it means the state.`);
            return hit;
          }
        }
        counts[kind]++;
        return to[kind];
      });
    }).join("");
    out.push({ ...step, email_body: text });

    if (skeleton(text) !== skeleton(step.email_body)) note(`Email ${step.order}: the spintax structure changed — refusing to use it.`);
    if (variablesIn(text).join() !== variablesIn(step.email_body).join()) note(`Email ${step.order}: a variable changed — refusing to use it.`);

    const left = mastersLeft(text, master, { ...target, area });
    if (left.length) note(`Email ${step.order}: the master's ${left.map((n) => `“${n}”`).join(", ")} ${left.length === 1 ? "is" : "are"} still in the copy in a form that can't be swapped safely.`);

    const said = plain(text);
    for (const [pattern, what] of RIDE_ALONG) {
      const hit = said.match(pattern);
      if (hit) note(`Email ${step.order}: the master's copy contains ${what} (“${hit[0].trim().slice(0, 60)}”) — it would be copied to the new client. Use a master without one.`);
    }

    const before = bodyText(step.email_body).split("\n");
    const after = bodyText(text).split("\n");
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      if (before[i] === after[i]) continue;
      changes.push({ order: step.order, before: before[i] ?? "", after: after[i] ?? "" });
      // A number on a place line is a street address / ZIP / phone that belongs to the master.
      if (/\d/.test(after[i] ?? "")) {
        note(`Email ${step.order}: a line with place names also contains a number — a street address or ZIP of the master would be copied to the new client: “${(after[i] ?? "").slice(0, 120)}”. Use a master without one.`);
      }
    }
  }

  const replacements = counts.area + counts.city + counts.state + counts.abbr;
  if (!replacements) note("None of the master's place names were found in its copy — check the master's area, city, state and abbreviation.");
  // An area name the master's emails never use would silently not appear.
  if (replacements && !counts.area && target.area.trim() && !same(target.area, defaultArea(target.city))) {
    note(`This master's emails don't use an area name, so “${target.area.trim()}” would not appear anywhere — clear the area name, or set the master's area name.`);
  }
  return { steps: out, changes, replacements, problems };
}
