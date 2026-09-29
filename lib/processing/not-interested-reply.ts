/**
 * Builds the reply body for "Not Interested (Send Reply)" — sent ~5–10 minutes
 * after a lead is marked (auto-reply cron), and loaded as the draft in the inbox
 * composer and the Data View bulk Review Queue. Faithful port of the Airtable
 * script the team used to run by hand.
 *
 * Tone is short and gracious — acknowledges the no, opens the door to future
 * contact, signs off with the original sender's first name.
 *
 * "Day of week" is computed in America/Los_Angeles so a Friday-night PT mark
 * doesn't say "have a good Saturday".
 *
 * PURE / dependency-free: runs in the browser (reply-compose) and on the server.
 */
import { KNOWN_FIRST_NAMES } from "@/lib/processing/first-names";

// ── Lead first name ─────────────────────────────────────────────────────────
// Thanking the wrong "name" ("thanks High", "thanks Customer") is worse than no
// name, so the rule is deliberately strict:
//   1. The reply's display name, then the lead name — only if it is EXACTLY two
//      real-looking words ("Pam Bush"). List suffixes like "(General Email)" and
//      a trailing "Team" are stripped first; "Crowley, Andy" → "Andy Crowley".
//   2. Otherwise the first name from the reply's sign-off / signature.
//   3. Otherwise no name at all.

/** Words that make a "name" a role, a department or a business, not a person. */
const NOT_A_NAME = new Set([
  "admin", "administrator", "assistant", "office", "team", "staff", "customer", "care", "support", "service",
  "services", "sales", "info", "information", "accounts", "accounting", "billing", "reception", "receptionist",
  "front", "desk", "manager", "management", "owner", "general", "email", "mail", "contact", "hello", "hi",
  "hey", "dear", "the", "and", "of", "for", "llc", "inc", "co", "corp", "company", "church", "school",
  "academy", "club", "center", "centre", "group", "department", "dept", "hr", "marketing", "business", "main",
  "noreply", "no-reply", "reply", "mailer", "daemon", "postmaster", "notification", "notifications",
  "automated", "auto", "system", "website", "web", "operations", "ops", "facility", "facilities",
  "maintenance", "janitorial", "cleaning", "restaurant", "shop", "store", "market", "dental", "medical",
  "law", "realty", "properties", "property", "investments", "team's", "partners", "associates", "clinic",
  "studio", "salon", "spa", "hotel", "inn", "resort", "farm", "ranch", "winery", "brewery", "bakery",
  "church's", "ministry", "ministries", "foundation", "association", "services'", "solutions", "systems",
  "enterprises", "industries", "international", "global", "national", "america", "usa", "hq", "desk's",
  // sign-off / filler words that turn up on name-shaped lines
  "thanks", "thank", "you", "regards", "best", "sincerely", "cheers", "sent", "from", "my", "iphone",
  "ipad", "android", "get", "outlook", "no", "not", "yes", "pass", "remove", "unsubscribe", "stop",
  "interested", "please", "happy", "good", "great", "all", "warm", "kind",
  // job titles / roles ("Executive Director, MCIE")
  "executive", "director", "president", "ceo", "cfo", "coo", "cto", "founder", "cofounder", "co-founder",
  "co-owner", "coordinator", "secretary", "treasurer", "chair", "chairman", "officer", "partner", "principal",
  "superintendent", "associate", "agent", "advisor", "specialist", "consultant", "representative", "rep",
  "supervisor", "head", "chief", "vp", "vice", "senior", "relations", "human", "resources", "finance",
  "admissions", "communications", "development", "program", "events", "event", "volunteer", "member",
  // business nouns — a signature line with one of these is a company, not a person
  "preschool", "montessori", "daycare", "childcare", "learning", "institute", "college", "university",
  "museum", "gallery", "society", "pantry", "league", "council", "chapter", "lodge", "temple", "parish",
  "fellowship", "baptist", "lutheran", "methodist", "catholic", "christian", "garage", "construction",
  "contractors", "contracting", "detailing", "funeral", "funerals", "consignment", "lawn", "painting",
  "printing", "packaging", "fence", "knives", "wellness", "aesthetics", "chiropractic", "acupuncture",
  "psychology", "counseling", "therapy", "pediatric", "pediatrics", "dentistry", "veterinary", "hospital",
  "pharmacy", "realtor", "insurance", "bank", "financial", "capital", "holdings", "ventures", "media",
  "design", "designs", "productions", "sports", "fitness", "gym", "yoga", "dance", "ballet", "music",
  "arts", "theatre", "theater", "motors", "automotive", "rentals", "supply", "supplies", "equipment",
  "manufacturing", "logistics", "trucking", "express", "catering", "kitchen", "cafe", "coffee", "pizza",
  "grill", "bistro", "bar", "pub", "wine", "brewing", "meats", "foods", "boutique", "jewelry", "florist",
  "landscaping", "roofing", "plumbing", "electric", "hvac", "heating", "cooling", "energy", "pros",
]);
const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "rev", "pastor", "coach", "fr", "father", "sister", "prof"]);

const clean = (s: string) => s.replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim();

/** One word that could be part of a person's name ("Katie", "O'Neil", "ANDY"). */
function isNameWord(w: string): boolean {
  if (!/^[A-Za-z][A-Za-z'’-]*[A-Za-z]$/.test(w)) return false; // letters; no trailing "'" ("Rockin'")
  if (!/[aeiouy]/i.test(w)) return false;                         // "MBTB", "TSC" — acronyms
  if (/[a-z]and[A-Z]/.test(w)) return false;                      // "DrewandLaney" — two people
  const lw = w.toLowerCase();
  return !NOT_A_NAME.has(lw) && !TITLES.has(lw);
}

/** "ANDY" → "Andy", "mariposa" → "Mariposa"; mixed case ("DeShawn") kept. */
function niceCase(w: string): string {
  if (w === w.toUpperCase() || w === w.toLowerCase()) return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  return w;
}

/** First name from a name FIELD, only when it's exactly two real-looking words. */
export function firstNameFromField(raw: string | null | undefined): string | null {
  let s = clean(String(raw ?? ""));
  if (!s) return null;
  s = s.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim(); // "(General Email)"
  s = s.replace(/\s+team$/i, "").trim();                         // "... Team"
  const comma = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (comma.length === 2 && !/\s/.test(comma[1])) s = `${comma[1]} ${comma[0]}`; // "Crowley, Andy"
  const words = s.split(" ").filter(Boolean);
  if (words.length !== 2 || !words.every(isNameWord)) return null;
  return niceCase(words[0]);
}

const SIGN_OFF = /^(thanks|thank you|thanks again|many thanks|thanks so much|thank you so much|best|best regards|best wishes|kind regards|warm regards|warmest regards|regards|sincerely|cheers|respectfully|all the best|take care|thx|blessings|god bless|with gratitude)[\s,!.]*$/i;
const INLINE_SIGN_OFF = /^(?:thanks|thank you|best|regards|cheers|sincerely|thx)[,!.]?\s*[-–—]?\s*([A-Za-z][A-Za-z'’-]+)\.?$/i;
const GREETING = /^(hi|hello|hey|dear|good (morning|afternoon|evening)|greetings)\b/i;

/** The lead's own message: cut at the quoted thread / device footers. */
function liveLines(body: string): string[] {
  const lines = body.replace(/\r/g, "").replace(/…\s*$/, "").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^>/.test(t)) break;
    if (/^-{2,}\s*(original message|mensaje original|message d'origine|ursprüngliche nachricht)/i.test(t) || /^_{5,}/.test(t)) break;
    // Quoted header in any common language: From / De / Von / Van / Da / Sent / Fecha…
    if (/^(from|de|von|van|da|sent|enviado|envoyé|gesendet|fecha|date|para|to|subject|asunto|objet|betreff):\s/i.test(t)) break;
    if (/^on .{4,}(wrote|schreef|a écrit):?$/i.test(t)) break;
    // "On Tue, Sep 29, 2026 at 10:03 AM Emma <" + next line "emma@x.com> wrote:"
    if (/^on\s.*\d/i.test(t) && /wrote:?\s*$/i.test(String(lines[i + 1] || ""))) break;
    if (/^(sent from my|get outlook for)/i.test(t)) break;
    out.push(t);
  }
  return out.map(clean).filter(Boolean);
}

/** A standalone signature line → its first name, e.g. "M. Michele Bradshaw",
 *  "Patti Richardson - Realtor 936-240-0800", "Geoff Hamelin". Company lines
 *  ("High Mountain Meats", "TANDY LEATHER") are filtered out later by
 *  requiring a known first name (see firstNameFromReply). */
function nameFromSignatureLine(line: string, allowSingle: boolean): string | null {
  // Address lines: "Dallas, TX 75240", "Brooklyn, NY 11217", "Cassopolis | 269…".
  if (/,\s*[A-Z]{2}\b/.test(line) || /\b\d{5}(?:-\d{4})?\b/.test(line)) return null;
  const head = line.split(/\s[-–—|]\s|,\s| \| /)[0].trim(); // drop " - Title" / ", Title"
  if (head.length > 40 || /[?!:;@/\\\d]/.test(head)) return null;
  const words = head.split(" ").filter(Boolean);
  if (!words.length || words.length > 3) return null;
  // Skip leading initials ("M.") and titles ("Pastor", "Dr.").
  let k = 0;
  while (k < words.length - 1 && (/^[A-Za-z]\.?$/.test(words[k]) || TITLES.has(words[k].replace(/\.$/, "").toLowerCase()))) k++;
  const rest = words.slice(k);
  if (!rest.every(isNameWord)) return null;
  if (rest.length < 2 && !allowSingle) return null; // a lone word needs a sign-off before it
  // Title-case check: signature names are capitalised ("Katie", "ANDY"), prose isn't.
  if (!rest.every((w) => /^[A-Z]/.test(w))) return null;
  return niceCase(rest[0]);
}

/**
 * First name from the reply's sign-off / signature, or null.
 *
 * A candidate only counts if it's a KNOWN first name (KNOWN_FIRST_NAMES, built
 * from our own reply data) or matches the lead's own identity (their email
 * address or name fields) — that's what separates "Geoff Hamelin" from a
 * company line like "High Mountain Meats" or a title like "Executive Director".
 */
export function firstNameFromReply(
  body: string | null | undefined,
  identity: string[] = [],
  companyWords: string[] = [],
): string | null {
  const ids = new Set(identity.map((s) => s.toLowerCase()).filter((s) => s.length >= 3));
  // The email only vouches for a name that isn't part of the company name
  // ("packology@" must not make "Packology" a first name).
  const company = new Set(companyWords.map((s) => s.toLowerCase()));
  const trusted = (n: string | null): n is string => {
    if (!n) return false;
    const l = n.toLowerCase();
    return KNOWN_FIRST_NAMES.has(l) || (ids.has(l) && !company.has(l));
  };
  const lines = liveLines(String(body ?? ""));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && (GREETING.test(line) || /^[A-Za-z]+[,:]$/.test(line))) continue; // "Hi Haley," / "Sarah:" = us
    const inline = line.match(INLINE_SIGN_OFF);
    if (inline && isNameWord(inline[1]) && trusted(niceCase(inline[1]))) return niceCase(inline[1]);
    if (SIGN_OFF.test(line) && lines[i + 1]) {
      const n = nameFromSignatureLine(lines[i + 1], true);
      if (trusted(n)) return n;
    }
    // A name line after the message itself (never the first line). A lone word
    // ("Jan") counts too, as long as it's a known first name.
    if (i >= 1) {
      const n = nameFromSignatureLine(line, true);
      if (trusted(n)) return n;
    }
  }
  return null;
}

/** Pieces of the lead's email address ("geoff.hamelin@" → geoff, hamelin) —
 *  exact-match only. Name FIELDS are deliberately not used: for "(General
 *  Email)" leads they hold the company, which would vouch for the company line
 *  in the signature ("High Mountain Meats"). */
function identityTokens(lead: NotInterestedLead): string[] {
  const local = String(lead.leadEmail ?? "").split("@")[0].toLowerCase();
  if (!local) return [];
  const parts = local.split(/[^a-z]+/).filter(Boolean);
  return parts.length > 1 ? parts : [local.replace(/[^a-z]/g, "")];
}

export interface NotInterestedLead {
  /** CRM lead name (often "Acme Team (General Email)"). */
  leadName?: string | null;
  /** Display name on the reply — the person who actually wrote back. */
  fromName?: string | null;
  /** The reply text, for sign-off / signature extraction. */
  replyBody?: string | null;
  /** Lead's email — a signature name matching it ("katie@…") is trusted. */
  leadEmail?: string | null;
  /** OUR sender (the rep). A name read out of the reply text must never be
   *  theirs — that means we picked up our own quoted signature / greeting. */
  senderName?: string | null;
}

/** The lead's first name for the reply, or null when there's no trustworthy one. */
export function pickLeadFirstName(lead: NotInterestedLead): string | null {
  const fromFields = firstNameFromField(lead.fromName) ?? firstNameFromField(lead.leadName);
  if (fromFields) return fromFields;
  const fromBody = firstNameFromReply(
    lead.replyBody,
    identityTokens(lead),
    String(lead.leadName ?? "").replace(/\([^)]*\)/g, " ").split(/[^A-Za-z'’-]+/),
  );
  const rep = senderFirstName(lead.senderName).toLowerCase();
  return fromBody && rep && fromBody.toLowerCase() === rep ? null : fromBody;
}

// ── Reply body ──────────────────────────────────────────────────────────────

function senderFirstName(name: string | null | undefined): string {
  const t = String(name ?? "").trim();
  if (!t) return "";
  if (t.includes(" ")) return t.split(/\s+/)[0];
  const camel = t.match(/^([A-Z][a-z]+)([A-Z][a-z]+)$/); // "JohnSmith" → "John"
  return camel ? camel[1] : t;
}

function dayOfWeekPT(now: Date): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/Los_Angeles" }).format(now);
}

/** "Have a good weekend!" on Friday, "...rest of your weekend." on Sat/Sun,
 *  "...rest of your Tuesday." otherwise. */
export function closingLineFor(now: Date = new Date()): string {
  const day = dayOfWeekPT(now);
  if (day === "Friday") return "Have a good weekend!";
  if (day === "Saturday" || day === "Sunday") return "Have a good rest of your weekend.";
  return `Have a good rest of your ${day}.`;
}

/**
 * @param lead  the lead (display name, lead name, reply body) — or, for older
 *              callers, just the lead name string.
 */
export function buildNotInterestedReply(
  lead: NotInterestedLead | string | null | undefined,
  senderName: string | null | undefined,
  now: Date = new Date(),
): string {
  const info: NotInterestedLead = typeof lead === "string" || lead == null ? { leadName: lead ?? null } : lead;
  const first = pickLeadFirstName({ ...info, senderName: info.senderName ?? senderName });
  const opener = first ? `Got it, thanks ${first}.` : "Got it, thanks for letting me know.";
  return `${opener} ${closingLineFor(now)}\n\nPlease email me if anything changes in the future. Happy to help.\n\n${senderFirstName(senderName)}`;
}
