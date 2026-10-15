/**
 * Setting a new client up in Reply Router (onboarding step "Set up in Reply
 * Router") — the pure part: read the CC / BCC people out of the Onboarding
 * Form's free-text answer, and write the reply template the way the other
 * clients' templates are written. Everything here is only a suggestion: the
 * step's preview shows each value in an editable field before anything is saved.
 *
 * Template shape (as used for every recent client):
 *   Hi {FIRST_NAME},
 *
 *   I'm CCing my boss Doug to this email since you're interested in {CONTEXT} for {COMPANY}.
 *
 *   Doug, can you please take it from here? Looks like a good number to call is {PHONE}.
 *
 *   Best,
 *
 *   {SENDER_NAME}
 *
 *   <company> / <website> / Phone: … / <address lines>
 */

export interface FormPerson { name: string; email: string; kind: "cc" | "bcc" }

const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const isEmail = (s: string) => /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s.trim());

/** Words that mean "a company or a shared mailbox", not a person. */
const COMPANY_WORDS = /\b(inc|llc|ltd|co|corp|company|solutions|services|cleaning|janitorial|group|team|systems|building|maintenance|commercial|enterprises|partners|office)\b/i;
const SHARED_MAILBOX = /^(info|sales|office|admin|team|contact|hello|support|service|services|accounts?|ops|operations)$/i;

/**
 * The people in the "everyone who should be CC'd" answer. Each email address
 * is one person; their name is the words just before it on the same line
 * ("CC: Laura Dampf Laura.Dampf@x.com", "Only me, Doug Ferrell dferrell@x.com").
 * A line starting with "BCC" makes that person a BCC.
 */
export function parseFormPeople(text: string): FormPerson[] {
  const out: FormPerson[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let last = 0;
    for (const m of line.matchAll(EMAIL_RE)) {
      const email = m[0].replace(/[.,;:]+$/, "");
      const before = line.slice(last, m.index ?? 0);
      last = (m.index ?? 0) + m[0].length;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const kind: FormPerson["kind"] = /^\s*bcc\b/i.test(before) || /\bbcc\s*:?\s*[^:]*$/i.test(before) ? "bcc" : "cc";
      // The name: the capitalised words just before the address ("… at this time Sean Terry" → "Sean Terry").
      const words = before
        .replace(/\b(b?cc)\s*:/gi, " ")
        .replace(/[<>()[\]"“”,;:|]/g, " ")
        .replace(/\s*[-–—]\s*$/, " ")
        .split(/\s+/)
        .filter(Boolean);
      const run: string[] = [];
      for (let k = words.length - 1; k >= 0 && run.length < 4; k--) {
        if (/^[A-Z][\w'’.&-]*$/.test(words[k]) && !/^(BCC|CC)$/.test(words[k])) run.unshift(words[k]);
        else break;
      }
      const name = run.join(" ");
      out.push({ name, email, kind });
    }
  }
  return out;
}

/** Whether a CC is a person (named) or a company / shared mailbox. */
export function isPerson(p: { name: string; email: string }): boolean {
  const local = p.email.split("@")[0] ?? "";
  if (SHARED_MAILBOX.test(local)) return false;
  if (!p.name || COMPANY_WORDS.test(p.name)) return false;
  return /^[A-Z][a-zA-Z'’-]+/.test(p.name);
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

/** "I'm CCing my boss Doug" / "my bosses Laura and Sherol" / "our team", and who's asked to take over. */
export function ccWording(people: { name: string; email: string }[]): { ccLine: string; askLine: string } {
  const persons = people.filter(isPerson);
  if (!persons.length || persons.length !== people.length) return { ccLine: "I'm CCing our team", askLine: "Team" };
  const names = persons.map((p) => firstName(p.name));
  if (names.length === 1) return { ccLine: `I'm CCing my boss ${names[0]}`, askLine: names[0] };
  if (names.length === 2) return { ccLine: `I'm CCing my bosses ${names[0]} and ${names[1]}`, askLine: `${names[0]} and ${names[1]}` };
  const head = names.slice(0, -1).join(", ");
  return { ccLine: `I'm CCing my bosses ${head}, and ${names[names.length - 1]}`, askLine: `${head}, or ${names[names.length - 1]}` };
}

/** "https://x.com/locations/a/?utm_source=gmb" → "https://x.com/locations/a/"; "Www.x.com" → "www.x.com". */
export function cleanWebsite(url: string): string {
  let s = url.trim().split(/\s+/)[0] ?? "";
  s = s.replace(/[?#].*$/, "");
  if (/^www\./i.test(s)) s = "www." + s.slice(4);
  return s;
}

/** The phone line: "Phone: 714.883.4795 (Laura) & 714.833.2139 (Sherol)" when each number has a name, else the numbers as given. */
export function phoneLine(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const PHONE = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
  const nums = [...text.matchAll(PHONE)];
  if (nums.length >= 2) {
    const named: string[] = [];
    let last = 0;
    for (const m of nums) {
      const label = text.slice(last, m.index ?? 0).replace(/[@:,&/]|\band\b|\bor\b/gi, " ").trim().split(/\s+/).filter(Boolean);
      last = (m.index ?? 0) + m[0].length;
      const who = label.length ? label[0] : "";
      named.push(who && /^[A-Z][a-z]/.test(who) ? `${m[0]} (${who})` : m[0]);
    }
    return `Phone: ${named.join(" & ")}`;
  }
  return `Phone: ${text}`;
}

/** The address as signature lines: "2332 Severn Avenue Suite 200, Metairie, LA 70001" → street / town line. */
export function addressLines(address: string): string[] {
  const a = address.replace(/\s+/g, " ").trim();
  if (!a) return [];
  const i = a.indexOf(",");
  if (i > 0 && /\d/.test(a.slice(0, i))) return [a.slice(0, i).trim(), a.slice(i + 1).trim()];
  return [a];
}

export function buildReplyTemplate(input: {
  people: { name: string; email: string }[];
  companyName: string; website: string; phones: string; address: string;
}): string {
  const { ccLine, askLine } = ccWording(input.people);
  const sig = [
    input.companyName.trim(),
    cleanWebsite(input.website),
    phoneLine(input.phones),
    ...addressLines(input.address),
  ].filter(Boolean);
  return [
    "Hi {FIRST_NAME},",
    "",
    `${ccLine} to this email since you're interested in {CONTEXT} for {COMPANY}.`,
    "",
    `${askLine}, can you please take it from here? Looks like a good number to call is {PHONE}.`,
    "",
    "Best,",
    "",
    "{SENDER_NAME}",
    ...(sig.length ? ["", ...sig] : []),
  ].join("\n");
}

/** Two addresses that are one or two typos apart (e.g. texaslovelyvleaning vs texaslovelycleaning). */
export function nearMiss(a: string, b: string): boolean {
  const x = a.trim().toLowerCase(), y = b.trim().toLowerCase();
  if (!x || !y || x === y || Math.abs(x.length - y.length) > 2) return false;
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => [i, ...new Array<number>(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
  }
  return d[x.length][y.length] <= 2;
}

/** Placeholders the reply template can use (lib/processing/template-resolver.ts fills them per lead). */
export const TEMPLATE_PLACEHOLDERS = ["{FIRST_NAME}", "{CONTEXT}", "{COMPANY}", "{PHONE}", "{SENDER_NAME}"] as const;
