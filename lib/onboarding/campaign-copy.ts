/**
 * Email copy for a new client's campaigns (onboarding step 2) — pure, no I/O.
 *
 * A new client's campaigns are copies of a MASTER client's campaigns with one
 * kind of change: the master's place names (area name, city, state, state
 * abbreviation) become the new client's.
 * Everything else is carried over character for character:
 *   • spintax          {Hey|Hi}, nested as deep as it goes
 *   • variables        {CITY} {QUESTION} {FIRST_NAME} {SENDER_FULL_NAME} …
 *                      (a {CAPS_NAME} with no "|" inside — never touched)
 *   • subjects         they only ever carry {CITY}, never a place name, so
 *                      they are not edited at all
 * After the swap the result is checked against the master (same braces and
 * pipes, same variables, no master place name left, no street address carried
 * over). Any failed check is a problem that blocks creating the campaigns.
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
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** HTML body → the text a person reads in the editor (for previews and checks). */
export const bodyText = (html: string) =>
  html.replace(/<br\s*\/?>/gi, "\n").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

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

interface Token { find: string; replace: string }

/** Master → new-client replacements, longest first so "Winnipeg Area" wins over "Winnipeg". */
function tokens(master: Place, target: Place): Token[] {
  const area = target.area.trim() || defaultArea(target.city);
  const list: Token[] = [
    { find: master.city.trim(), replace: target.city.trim() },
    { find: master.state.trim(), replace: target.state.trim() },
    { find: master.abbr.trim(), replace: target.abbr.trim() },
  ];
  if (master.area.trim() && master.area.trim() !== master.city.trim()) list.push({ find: master.area.trim(), replace: area });
  return list.filter((t) => t.find).sort((a, b) => b.find.length - a.find.length);
}

/** Whole-word, case-sensitive matcher for a list of names (HTML-escaped like the body). */
function matcher(names: string[], flags = ""): RegExp | null {
  const alt = names.filter(Boolean).sort((a, b) => b.length - a.length).map((n) => escapeRegExp(escapeHtml(n))).join("|");
  return alt ? new RegExp(`(?<![A-Za-z0-9])(?:${alt})(?![A-Za-z0-9])`, flags) : null;
}
/** A body's free text: everything except {VARIABLES} and <tags>. */
const freeText = (body: string) => body.split(/\{[A-Z][A-Z0-9_]*\}|<[^>]+>/g).join(" ");

/** Swap place names in one HTML body. Variables and tags are never touched. */
function swap(body: string, list: Token[]): { text: string; count: number } {
  const re = matcher(list.map((t) => t.find), "g");
  if (!re) return { text: body, count: 0 };
  const byFind = new Map(list.map((t) => [escapeHtml(t.find), escapeHtml(t.replace)]));
  let count = 0;
  // Split into protected pieces ({VARIABLES} and <tags>) and free text.
  const text = body.split(/(\{[A-Z][A-Z0-9_]*\}|<[^>]+>)/g).map((piece, i) => {
    if (i % 2 === 1) return piece; // a variable or a tag — verbatim
    return piece.replace(re, (m) => { count++; return byFind.get(m) ?? m; });
  }).join("");
  return { text, count };
}

/**
 * The master's steps rewritten for a new client. Subjects are returned exactly
 * as they are; only bodies change, and only where a master place name stood.
 */
export function localizeSteps<T extends CopyStep>(steps: T[], master: Place, target: Place): LocalizeResult<T> {
  const problems = [...placeProblems(master, "Master"), ...placeProblems(target, "New client")];
  const list = tokens(master, target);
  const masterNames = tokens(master, master).map((t) => t.find);
  const inSubject = matcher(masterNames);
  const out: T[] = [];
  const changes: CopyChange[] = [];
  let replacements = 0;

  for (const step of [...steps].sort((a, b) => a.order - b.order)) {
    const { text, count } = problems.length ? { text: step.email_body, count: 0 } : swap(step.email_body, list);
    replacements += count;
    out.push({ ...step, email_body: text });

    // Subjects are never edited, so a place name in one can't be localised.
    if (inSubject?.test(escapeHtml(step.email_subject))) {
      problems.push(`Email ${step.order}: the subject contains one of the master's place names — subjects aren't edited, so this master can't be used as it is.`);
    }
    if (problems.length) continue;

    if (skeleton(text) !== skeleton(step.email_body)) problems.push(`Email ${step.order}: the spintax structure changed — refusing to use it.`);
    if (variablesIn(text).join() !== variablesIn(step.email_body).join()) problems.push(`Email ${step.order}: a variable changed — refusing to use it.`);

    const before = bodyText(step.email_body).split("\n");
    const after = bodyText(text).split("\n");
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      if (before[i] === after[i]) continue;
      changes.push({ order: step.order, before: before[i] ?? "", after: after[i] ?? "" });
      // A number on a place line is a street address / ZIP / phone that belongs to the master.
      if (/\d/.test(after[i] ?? "")) {
        problems.push(`Email ${step.order}: a line with place names also contains a number — a street address or ZIP of the master would be copied to the new client: “${(after[i] ?? "").slice(0, 120)}”. Use a master without one.`);
      }
    }
  }

  if (!problems.length) {
    // Nothing of the master may remain. The new client's own names are taken
    // out first, so "York" → "New York" (or a shared state) isn't a false alarm.
    const mine = matcher(list.map((t) => t.replace), "g");
    const stale = matcher(masterNames);
    for (const s of out) {
      const rest = mine ? freeText(s.email_body).replace(mine, " ") : freeText(s.email_body);
      if (stale?.test(rest)) problems.push(`Email ${s.order}: one of the master's place names is still in the copy.`);
    }
    if (!replacements) problems.push("None of the master's place names were found in its copy — check the master's area, city, state and abbreviation.");
  }
  return { steps: out, changes, replacements, problems };
}
