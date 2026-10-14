/**
 * Master email copy for new clients' campaigns — the model, its checks, the
 * preview, and how it is written to Email Bison. Pure and browser-safe: the
 * editor, the API and the campaign builder all use these same functions.
 *
 * A sequence is a list of emails. Each email after the first says how many
 * days after the previous one it goes out, and whether it replies in the same
 * thread or starts a new one (a new thread uses email 1's subject unless it
 * has its own).
 *
 * Text uses Email Bison's own syntax, unchanged: `{a|b|c}` picks one option,
 * `{|x}` makes x optional, and `{FIRST_NAME}` (capitals, no `|`) is a Bison
 * variable. Client fields that are filled in per client when the campaigns
 * are made are written `[[SERVICE_AREA]]`, `[[OFFICE_ADDRESS]]`,
 * `[[COMPANY_NAME]]` and never reach Bison as such.
 *
 * Proven on OPSLABS test campaigns (2026-10-15): Bison stores a body as HTML
 * (line break → <br>, & → &amp;) and DELETES anything in angle brackets; it
 * prefixes "Re: " to the subject of a reply-in-thread email; and anything put
 * in `email_subject_variables` is appended to the subject — so that is always
 * sent empty.
 */

export const CLIENT_TYPES = [
  { key: "cleaning", label: "Cleaning Client", short: "Cleaning" },
  { key: "non_cleaning", label: "Non-Cleaning Client", short: "Non-Cleaning" },
  { key: "os", label: "OS Client", short: "OS" },
  { key: "internal", label: "Internal", short: "Internal" },
] as const;
export type ClientTypeKey = (typeof CLIENT_TYPES)[number]["key"];
export const isClientType = (v: unknown): v is ClientTypeKey => CLIENT_TYPES.some((t) => t.key === v);
export const clientTypeLabel = (k: ClientTypeKey) => CLIENT_TYPES.find((t) => t.key === k)!.label;

export type ThreadMode = "new" | "reply";
export interface CopyStep {
  /** Days after the previous email (ignored for email 1). */
  waitDays: number;
  /** Email 1 is always a new thread. */
  thread: ThreadMode;
  /** Email 1: required. A later new-thread email: its own subject, or null = email 1's. Replies: unused. */
  subject: string | null;
  body: string;
}
export interface CopySequence { steps: CopyStep[] }

/** Bison variables seen in the copy in use (Clay, live campaigns). Others are allowed but flagged. */
export const KNOWN_VARIABLES = [
  "FIRST_NAME", "LAST_NAME", "COMPANY", "TITLE", "EMAIL", "CITY", "STATE", "QUESTION",
  "SENDER_FIRST_NAME", "SENDER_LAST_NAME", "SENDER_FULL_NAME",
] as const;
export const CLIENT_FIELDS = [
  { key: "SERVICE_AREA", label: "Service area", hint: "The client's service-area line (spintax), written per client." },
  { key: "OFFICE_ADDRESS", label: "Office address", hint: "The client's office address (spintax), written per client." },
  { key: "COMPANY_NAME", label: "Company name", hint: "The client's company name." },
] as const;
export type ClientFieldKey = (typeof CLIENT_FIELDS)[number]["key"];

export const LIMITS = { maxSteps: 10, minWait: 1, maxWait: 90, maxSubject: 1000, maxBody: 20_000 } as const;

/** The structure the client asked for (2026-10-15): new, +2 reply, +3 reply, +15 new with email 1's subject. */
export function defaultStructure(): CopyStep[] {
  return [
    { waitDays: 0, thread: "new", subject: "", body: "" },
    { waitDays: 2, thread: "reply", subject: null, body: "" },
    { waitDays: 3, thread: "reply", subject: null, body: "" },
    { waitDays: 15, thread: "new", subject: null, body: "" },
  ];
}

// ── Reading the syntax ──────────────────────────────────────────────────────

export type TokenKind = "text" | "open" | "close" | "pipe" | "variable" | "field" | "bad";
export interface Token { kind: TokenKind; text: string; start: number }

/**
 * Split text into tokens for highlighting and checking. `{NAME}` (capitals,
 * digits, underscores — no `|`, no spaces) is a variable; `[[NAME]]` a client
 * field; other braces and pipes are spintax. Angle brackets are `bad`.
 */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let buf = "", bufStart = 0;
  const flush = () => { if (buf) out.push({ kind: "text", text: buf, start: bufStart }); buf = ""; };
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i);
    const v = rest.match(/^\{([A-Z][A-Z0-9_]*)\}/);
    if (v) { flush(); out.push({ kind: "variable", text: v[0], start: i }); i += v[0].length; bufStart = i; continue; }
    const f = rest.match(/^\[\[([A-Za-z_]+)\]\]/);
    if (f) { flush(); out.push({ kind: "field", text: f[0], start: i }); i += f[0].length; bufStart = i; continue; }
    const ch = text[i];
    if (ch === "{" || ch === "}" || ch === "|" || ch === "<" || ch === ">") {
      flush();
      out.push({ kind: ch === "{" ? "open" : ch === "}" ? "close" : ch === "|" ? "pipe" : "bad", text: ch, start: i });
      i++; bufStart = i; continue;
    }
    if (!buf) bufStart = i;
    buf += ch; i++;
  }
  flush();
  return out;
}

export interface Problem { message: string; start?: number }

/** What is wrong with one piece of text (subject or body): errors block saving, warnings don't. */
export function checkText(text: string): { errors: Problem[]; warnings: Problem[] } {
  const errors: Problem[] = [], warnings: Problem[] = [];
  const stack: number[] = [];
  let pipeOutside = -1;
  let prev: Token | null = null;
  for (const t of tokenize(text)) {
    if (t.kind === "text") {
      // A real client field is its own token, so brackets left in plain text are a typo
      // ([[SERVICE AREA]], [SERVICE_AREA], an extra ]) — they would reach leads as written.
      const at = (i: number) => t.start + Math.max(0, i);
      if (/\[\[|\]\]/.test(t.text)) errors.push({ message: `A [[client field]] is mistyped — write it exactly as ${CLIENT_FIELDS.map((f) => `[[${f.key}]]`).join(", ")}.`, start: at(t.text.search(/\[\[|\]\]/)) });
      else if (/\[[A-Za-z][A-Za-z0-9_ -]*\]/.test(t.text)) errors.push({ message: `“${t.text.match(/\[[A-Za-z][A-Za-z0-9_ -]*\]/)![0]}” looks like a placeholder — client fields use double brackets, like [[SERVICE_AREA]].`, start: at(t.text.search(/\[[A-Za-z]/)) });
      else if (prev?.kind === "field" && /^\]/.test(t.text)) errors.push({ message: "An extra ] after a [[client field]] — remove it.", start: t.start });
      else if (/[[\]]/.test(t.text)) warnings.push({ message: "Square brackets are unusual in an email — make sure this isn't a mistyped [[client field]].", start: at(t.text.search(/[[\]]/)) });
    }
    prev = t;
    if (t.kind === "open") stack.push(t.start);
    else if (t.kind === "close") { if (!stack.length) errors.push({ message: "A } closes nothing — remove it or add its {.", start: t.start }); else stack.pop(); }
    else if (t.kind === "pipe" && !stack.length && pipeOutside < 0) pipeOutside = t.start;
    else if (t.kind === "bad") errors.push({ message: `“${t.text}” isn't allowed: Email Bison deletes anything inside angle brackets.`, start: t.start });
    else if (t.kind === "field") {
      const key = t.text.slice(2, -2);
      if (!CLIENT_FIELDS.some((f) => f.key === key)) errors.push({ message: `${t.text} isn't a client field. Use ${CLIENT_FIELDS.map((f) => `[[${f.key}]]`).join(", ")}.`, start: t.start });
    } else if (t.kind === "variable") {
      const key = t.text.slice(1, -1);
      if (!(KNOWN_VARIABLES as readonly string[]).includes(key)) warnings.push({ message: `${t.text} isn't one of the usual variables — check every lead has it, or it sends blank.`, start: t.start });
    }
  }
  for (const s of stack) errors.push({ message: "A { is never closed — add its }.", start: s });
  if (pipeOutside >= 0) errors.push({ message: "A | outside any { } — options must sit inside braces, like {Hi|Hey}.", start: pipeOutside });
  if (/\{\s*\}/.test(text)) errors.push({ message: "An empty { } — remove it or add options.", start: text.search(/\{\s*\}/) });
  return { errors, warnings };
}

export interface StepIssue { step: number; part: "subject" | "body" | "wait" | "thread"; message: string; start?: number }
export interface SequenceCheck { errors: StepIssue[]; warnings: StepIssue[] }

/** Everything that would stop this sequence from being saved, or deserves a second look. */
export function checkSequence(seq: CopySequence): SequenceCheck {
  const errors: StepIssue[] = [], warnings: StepIssue[] = [];
  const steps = seq.steps;
  if (!steps.length) errors.push({ step: 0, part: "body", message: "Add at least one email." });
  if (steps.length > LIMITS.maxSteps) errors.push({ step: LIMITS.maxSteps, part: "body", message: `At most ${LIMITS.maxSteps} emails.` });
  steps.forEach((s, i) => {
    const n = i + 1;
    if (i === 0 && s.thread !== "new") errors.push({ step: n, part: "thread", message: "Email 1 always starts a new thread." });
    if (i > 0 && (!Number.isInteger(s.waitDays) || s.waitDays < LIMITS.minWait || s.waitDays > LIMITS.maxWait)) {
      errors.push({ step: n, part: "wait", message: `The wait before email ${n} must be a whole number of days from ${LIMITS.minWait} to ${LIMITS.maxWait}.` });
    }
    const ownSubject = i === 0 || (s.thread === "new" && s.subject !== null);
    if (ownSubject) {
      const subj = s.subject ?? "";
      if (!subj.trim()) errors.push({ step: n, part: "subject", message: i === 0 ? "Email 1 needs a subject." : `Email ${n} needs a subject, or use email 1's.` });
      if (subj.length > LIMITS.maxSubject) errors.push({ step: n, part: "subject", message: `The subject is too long (${subj.length} characters).` });
      if (/\n/.test(subj)) errors.push({ step: n, part: "subject", message: "A subject can't contain a line break." });
      const c = checkText(subj);
      for (const e of c.errors) errors.push({ step: n, part: "subject", ...e });
      for (const w of c.warnings) warnings.push({ step: n, part: "subject", ...w });
    }
    if (!s.body.trim()) errors.push({ step: n, part: "body", message: `Email ${n} has no text.` });
    if (s.body.length > LIMITS.maxBody) errors.push({ step: n, part: "body", message: `Email ${n} is too long (${s.body.length} characters).` });
    const c = checkText(s.body);
    for (const e of c.errors) errors.push({ step: n, part: "body", ...e });
    for (const w of c.warnings) warnings.push({ step: n, part: "body", ...w });
  });
  return { errors, warnings };
}

/** The email that starts the thread `index` is in: itself for a new thread, else the nearest new thread before it. */
export function threadStart(seq: CopySequence, index: number): number {
  let i = index;
  while (i > 0 && seq.steps[i]?.thread === "reply") i--;
  return i;
}

/**
 * The subject an email is sent with (before Bison adds "Re: " to replies): a
 * reply takes the subject of the email that started its thread; a new thread
 * its own subject, or email 1's when it has none.
 */
export function subjectOf(seq: CopySequence, index: number): string {
  const start = threadStart(seq, index);
  const s = seq.steps[start];
  if (start === 0 || !s || s.subject === null) return seq.steps[0]?.subject ?? "";
  return s.subject;
}

/** Day each email goes out, counting email 1 as day 0. */
export function sendDays(seq: CopySequence): number[] {
  let day = 0;
  return seq.steps.map((s, i) => (i === 0 ? 0 : (day += s.waitDays)));
}

// ── Preview ─────────────────────────────────────────────────────────────────

/** A small seeded random generator, so a preview can be reshuffled and repeated. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One way the text could read: every `{a|b}` resolved with `rand`, variables
 * and client fields replaced from `values` (left as written when missing).
 * Unbalanced text is rendered as far as it goes.
 */
export function renderSpin(text: string, rand: () => number, values: Record<string, string> = {}): string {
  const tokens = tokenize(text);
  let pos = 0;
  const parseSeq = (stopAtPipeOrClose: boolean): string[][] => {
    // Returns the alternatives of the current group (one entry when not inside braces).
    const alts: string[][] = [[]];
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (stopAtPipeOrClose && t.kind === "close") { pos++; return alts; }
      if (stopAtPipeOrClose && t.kind === "pipe") { alts.push([]); pos++; continue; }
      pos++;
      if (t.kind === "open") {
        const inner = parseSeq(true);
        const pick = inner[Math.floor(rand() * inner.length)] ?? [];
        alts[alts.length - 1].push(pick.join(""));
      } else if (t.kind === "variable") {
        const key = t.text.slice(1, -1);
        alts[alts.length - 1].push(values[key] ?? t.text);
      } else if (t.kind === "field") {
        const key = t.text.slice(2, -2);
        alts[alts.length - 1].push(values[key] ?? t.text);
      } else if (t.kind === "close" || t.kind === "pipe") {
        alts[alts.length - 1].push(t.text);
      } else {
        alts[alts.length - 1].push(t.text);
      }
    }
    return alts;
  };
  return (parseSeq(false)[0] ?? []).join("");
}

/** Roughly how many different ways the text can read (capped, for display). */
export function countVariants(text: string, cap = 1e12): number {
  const tokens = tokenize(text);
  let pos = 0;
  const group = (): number => {
    // inside braces: sum over alternatives of the product within each
    let total = 0, prod = 1;
    while (pos < tokens.length) {
      const t = tokens[pos++];
      if (t.kind === "close") return Math.min(cap, total + prod);
      if (t.kind === "pipe") { total += prod; prod = 1; continue; }
      if (t.kind === "open") prod = Math.min(cap, prod * group());
    }
    return Math.min(cap, total + prod);
  };
  let prod = 1;
  while (pos < tokens.length) {
    const t = tokens[pos++];
    if (t.kind === "open") prod = Math.min(cap, prod * group());
  }
  return prod;
}

// ── To Email Bison ──────────────────────────────────────────────────────────

export interface BisonStepPayload {
  order: number;
  email_subject: string;
  email_subject_variables: [];
  email_body: string;
  wait_in_days: number;
  thread_reply: boolean;
  variant: false;
}

/** Fill the client fields. Every field used must have a value — a blank would go out as-is. */
export function fillClientFields(text: string, fields: Partial<Record<ClientFieldKey, string>>): { text: string; missing: ClientFieldKey[] } {
  const missing = new Set<ClientFieldKey>();
  const out = text.replace(/\[\[([A-Za-z_]+)\]\]/g, (m, key: string) => {
    const v = fields[key as ClientFieldKey];
    if (v == null || !String(v).trim()) { missing.add(key as ClientFieldKey); return m; }
    return String(v);
  });
  return { text: out, missing: [...missing] };
}

/**
 * The steps as Bison's create call takes them. Bison's `wait_in_days` sits on
 * the EARLIER email (days until the next one), so each step carries the next
 * step's wait; the last carries 1 (unused — nothing follows).
 */
export function toBisonSteps(seq: CopySequence, fields: Partial<Record<ClientFieldKey, string>>): { steps: BisonStepPayload[]; missing: ClientFieldKey[]; problems: string[] } {
  const missing = new Set<ClientFieldKey>();
  const problems: string[] = [];
  const steps = seq.steps.map((s, i) => {
    const subject = fillClientFields(subjectOf(seq, i), fields);
    const body = fillClientFields(s.body, fields);
    subject.missing.forEach((m) => missing.add(m));
    body.missing.forEach((m) => missing.add(m));
    // The client's own values (spintax lines, addresses) are checked once they're in place.
    if (!subject.missing.length) for (const e of checkText(subject.text).errors) problems.push(`Email ${i + 1} subject: ${e.message}`);
    if (!body.missing.length) for (const e of checkText(body.text).errors) problems.push(`Email ${i + 1}: ${e.message}`);
    return {
      order: i + 1,
      email_subject: subject.text,
      email_subject_variables: [] as [],
      email_body: body.text,
      wait_in_days: i < seq.steps.length - 1 ? seq.steps[i + 1].waitDays : 1,
      thread_reply: i > 0 && s.thread === "reply",
      variant: false as const,
    };
  });
  return { steps, missing: [...missing], problems };
}

/** What Bison will hold after saving a body (proven): line breaks as <br>, & as &amp;. */
export function asBisonStores(body: string): string {
  return body.replace(/&/g, "&amp;").replace(/\r\n|\r|\n/g, "<br>");
}

/** The subject Bison will hold for a step (proven): "Re: " added on a reply in the same thread. */
export function bisonSubject(subject: string, thread: boolean): string {
  return thread ? `Re: ${subject}` : subject;
}

/** Normalise steps coming from a request: only the known fields, sensible types. */
export function cleanSequence(input: unknown): CopySequence | null {
  const raw = (input as { steps?: unknown })?.steps;
  if (!Array.isArray(raw)) return null;
  const steps: CopyStep[] = raw.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const thread: ThreadMode = i === 0 ? "new" : o.thread === "reply" ? "reply" : "new";
    const subject = i === 0 ? String(o.subject ?? "") : thread === "new" && typeof o.subject === "string" ? o.subject : null;
    return {
      waitDays: i === 0 ? 0 : Number(o.waitDays),
      thread,
      subject,
      body: String(o.body ?? "").replace(/\r\n|\r/g, "\n"),
    };
  });
  return { steps };
}
