/**
 * Extract the lead's location from their REPLY text.
 *
 * Top of the location-audit priority stack (lib/qualification/qualify-lead.ts):
 *   1. the lead's reply body       ← this module (source "body")
 *   2. the signature in the reply  ← this module (source "signature")
 *   3. CRM custom variables        ← only when the reply has no location
 *
 * What counts: where the lead / their company / facility is, AND the place they
 * want serviced ("quote for our premises in Leeds", "do you cover Weston-super-
 * Mare?"). A postcode alone or a country alone counts too — any of them beats a
 * stale CRM address. Not US-only: a UK postcode / "United Kingdom" is returned
 * as such, so the audit can fail an out-of-country lead.
 *
 * Strict by design: never invents a location. The returned evidence (the lead's
 * own words) or one of the fields must actually appear in the reply, otherwise
 * the result is discarded and the caller falls back to the CRM.
 */

export interface ReplyLocation {
  city: string | null;
  state: string | null;     // 2-letter US state, else region / county / province
  country: string | null;   // full English name, e.g. "United Kingdom"
  address: string | null;   // street address only when the lead wrote one
  zip: string | null;       // ZIP or postcode exactly as written
  /** Where in the reply the location came from. */
  source: "body" | "signature";
  /** The lead's own words that state the location (quoted in the audit reason). */
  evidence: string;
}

const SYSTEM_PROMPT = `You read a sales lead's email reply — ONLY the lead's own new message (the quoted thread below it has already been removed) — and extract the location of the lead, their company, or the premises they want serviced.

Respond with ONLY valid JSON in this shape:
{ "city": string|null, "state": string|null, "country": string|null, "address": string|null, "zip": string|null, "source": "body"|"signature"|null, "evidence": string|null }

COUNTS as the lead's location:
- Where they say they / their company / facility are ("we're in Indianapolis", "our office at 123 Main St").
- The place they want the service, or ask whether we cover ("quote for cleaning our premises in Leeds", "do you cover Weston-super-Mare?", "it's for our site in Tampa").
- An address, city, ZIP/postcode or country in their signature block (lines after the sign-off or under their name).
- A ZIP/postcode on its own, or a country on its own, still counts — return whatever is there.

Does NOT count (return nulls for these):
- A different office or person they redirect us to ("contact our LA office", "our Dallas HQ handles this").
- Places that are not theirs (somewhere they are travelling to, an example, a mention of OUR company's city).
- Generic statements with no place ("we're nationwide", "all our locations").

Fields:
- "country": full English name ("United Kingdom", "Canada", "United States"). Use "United States" for a US city / state / ZIP. null if unclear.
- "state": 2-letter abbreviation for a US state; otherwise the region / county / province, or null.
- "zip": the ZIP or postcode exactly as written (e.g. "BS24 9ES", "46204").
- "address": a street address ONLY if they wrote one — never compose one from a city.
- "source": "signature" if it came from the signature block, otherwise "body".
- "evidence": copy the exact words from the reply that state the location (max ~120 characters).
If the reply contains no location of the lead's own, return every field as null.`;

export async function extractReplyLocation(
  replyText: string,
  opts: { senderName?: string | null } = {},
): Promise<ReplyLocation | null> {
  const text = (replyText || "").trim();
  if (!text) return null;
  if (!process.env.OPENAI_API_KEY) return null;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...(opts.senderName?.trim()
          ? [{ role: "system", content: `Our sales rep who emailed the lead is "${opts.senderName.trim()}". Their signature and our outreach wording ("we provide commercial cleaning…", "would you be open to a quote…") can appear inside the reply (auto-replies sometimes paste our email in). NEVER return a location from our rep's signature or our outreach text.` }]
          : []),
        { role: "user", content: text.slice(0, 3000) },
      ],
    }),
  });
  // Surface API failures to the caller (it logs them) instead of silently
  // falling back to the CRM as if the reply had no location.
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const data = await response.json();
  const raw = (data?.choices?.[0]?.message?.content || "").trim();
  if (!raw) return null;

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const city = clean(parsed.city);
  const state = clean(parsed.state);
  const country = clean(parsed.country);
  const address = clean(parsed.address);
  const zip = clean(parsed.zip);
  const evidence = (clean(parsed.evidence) || "").replace(/\s+/g, " ").slice(0, 160);

  // Any one of these is enough — a postcode or a country alone still beats a
  // stale CRM address.
  if (!city && !address && !zip && !country) return null;

  // Never invented: the LOCATION itself must be written in the lead's message —
  // a ZIP / city / street, a state code as a whole word, or the country (or a
  // common alias like "UK"). A place guessed from a company name ("Artesa
  // Estate" → California) is rejected, and the caller falls back to the CRM.
  const hay = norm(text);
  const has = (v: string | null) => !!v && hay.includes(norm(v));
  const hasWord = (v: string | null) => !!v && new RegExp(`(^|[^a-z])${escapeRe(norm(v))}([^a-z]|$)`).test(hay);
  const countryWritten = !!country && [country, ...(COUNTRY_ALIASES[country.toLowerCase()] || [])].some(hasWord);
  // 2-letter state codes double as words ("IN", "OR", "ME", "OK") — they must be
  // written in capitals, as in an address; full state / region names match normally.
  const stateWritten = !!state && (/^[A-Z]{2}$/.test(state)
    ? new RegExp(`(^|[^A-Za-z])${state}([^A-Za-z]|$)`).test(text)
    : hasWord(state));
  const grounded = has(zip) || has(city) || has(address) || stateWritten || countryWritten;
  if (!grounded) return null;

  return {
    city, state, country, address, zip,
    source: parsed.source === "signature" ? "signature" : "body",
    evidence: evidence || [address, city, state, zip, country].filter(Boolean).join(", "),
  };
}

const COUNTRY_ALIASES: Record<string, string[]> = {
  "united kingdom": ["uk", "u.k.", "england", "scotland", "wales", "northern ireland", "great britain", "britain"],
  "united states": ["usa", "u.s.a.", "u.s.", "america"],
  "canada": ["canada"],
  "australia": ["australia"],
  "ireland": ["ireland", "eire"],
  "mexico": ["mexico", "méxico"],
};
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.toLowerCase() === "null") return null;
  return t;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}
