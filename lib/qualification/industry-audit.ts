/**
 * GPT-based industry audit: checks if a company falls under excluded industries.
 * Uses enriched data (verified industry from web research) for higher accuracy.
 * Returns "Passed" (not excluded), "Failed" (excluded), or "Residential".
 *
 * Three layers of checks (in order, v2):
 * 1. GLOBAL: Cleaning/washing companies excluded for ALL clients (based on company name/website/industry)
 * 2. REPLY TEXT: Residential/house/home/farm/airbnb inquiries (based on lead's reply)
 * 3. PER-CLIENT: Client-specific exclusion/inclusion rules (GPT-based)
 */

import { geminiJSON } from "@/lib/gemini";

interface IndustryAuditResult {
  result: "Passed" | "Failed" | "Residential";
  reason: string;
}

/**
 * GLOBAL EXCLUSION: Cleaning/washing companies are competitors, not prospects.
 * Checked against company name, website, verified industry, AND the lead's
 * own email domain (in case the company name field is blank but the lead
 * emails from a known competitor brand domain, e.g. paul@jantize.com).
 *
 * Two categories:
 *   1. Generic industry keywords  ("cleaning", "janitorial", …)
 *   2. Franchise / brand names    ("jantize", "jan-pro", …) — caught even
 *      when the company name doesn't contain a generic industry word.
 *
 * Anything matched here fails for EVERY client — no exceptions.
 */
const COMPETITOR_KEYWORDS = [
  // ── Generic industry terms ──
  "cleaning", "window cleaning", "carpet cleaning",
  "pressure washing", "power washing", "exterior cleaning",
  "parking lot cleaning", "janitorial", "maid service",
  "house cleaning", "home cleaning",
  // ── Known cleaning / janitorial franchise brands ──
  // These are catch-all substrings — if a lead's company or email
  // contains any of them, they're almost certainly a competitor.
  "jantize",
  "jan-pro", "janpro",
  "jani-king", "janiking",
  "coverall",
  "vanguard cleaning",
  "stratus building",
  "anago",
  "servicemaster",
  "servpro", "serv-pro",
  "chem-dry", "chemdry",
  "city wide facility", "city wide commercial",
  "merry maids",
  "molly maid",
  "the cleaning authority",
  "two maids",
  "coit cleaning",
  "stanley steemer",
];

/**
 * Check company data (name + website + industry + lead email) for
 * competitor companies. The email is included as a backstop: when
 * enrichment fails (CRM-only path) the website + industry fields are
 * empty, but the lead's own email often gives us the domain — and a
 * lead emailing from @jantize.com is unambiguously a competitor even
 * if every other field is blank.
 */
function checkCompanyForCompetitor(
  companyName: string,
  website: string | null,
  industry: string,
  leadEmail: string | null,
): { keyword: string } | null {
  const combined = [companyName, website, industry, leadEmail]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const match = COMPETITOR_KEYWORDS.find((kw) => combined.includes(kw));
  return match ? { keyword: match } : null;
}

/** Lead's reply asks about residential cleaning → Residential */
const RESIDENTIAL_KEYWORDS = ["residential"];

/** Lead's reply asks about these → Failed (not a fit) */
const REPLY_FAILED_KEYWORDS = [
  "house cleaning",
  "home cleaning",
  "home office",
  "food truck",
  "farm cleaning",
  "farm",
  "airbnb",
  "apartment unit",
  "apartment cleaning",
  "my house",
  "my home",
  "my apartment",
];

/**
 * Check the lead's reply for residential/non-commercial inquiries.
 * Only the reply text matters — not company data or website.
 */
function checkReplyForResidential(replyText: string): { result: "Residential" | "Failed"; keyword: string } | null {
  if (!replyText) return null;
  const lower = replyText.toLowerCase();

  // Check "residential" first → Residential
  const resMatch = RESIDENTIAL_KEYWORDS.find((kw) => lower.includes(kw));
  if (resMatch) return { result: "Residential", keyword: resMatch };

  // Check house/home/farm/airbnb/etc → Failed
  const failMatch = REPLY_FAILED_KEYWORDS.find((kw) => lower.includes(kw));
  if (failMatch) return { result: "Failed", keyword: failMatch };

  return null;
}

const SYSTEM_PROMPT = `You are a business-classification auditor for a commercial cleaning / B2B services company. Given a company and a client's industry rules, determine if the company operates in an excluded industry.

USE GOOGLE SEARCH to determine the company's REAL industry whenever the provided industry is missing, generic, or unclear — look up the company name and/or its website domain on the web before deciding.

RULES INTERPRETATION:
- These rules are ALWAYS an EXCLUSION LIST unless the text EXPLICITLY says "we only want to work with", "only accept", or "we only want". A bare list of industries is an EXCLUSION (exclude those), never "only accept".
- DEFAULT (exclusion): FAIL only if the company clearly operates in one of the excluded industries. PASS otherwise. When in doubt, PASS.
- ONLY if the text explicitly says "we only want"/"only accept": treat as inclusion-only → FAIL if the company is NOT in the specified industry.

DISAMBIGUATION — do NOT over-fail these common mistakes (each backed by a real error):
- A BAKERY / bake shop / patisserie / cafe / coffee shop is NOT a "restaurant" unless the rules explicitly exclude bakeries or cafes.
- An entertainment or event VENUE (comedy club, theater, music venue, wedding venue, banquet/event hall) is NOT a "restaurant" even if it serves food — only sit-down dining establishments count as restaurants.
- REAL ESTATE defaults to COMMERCIAL real estate (not excluded) unless the company clearly does RESIDENTIAL real estate / homes / houses.
- A company that merely has a kitchen, sells food as a side, or supplies an industry is NOT automatically in that industry — judge by its PRIMARY business.

IGNORE in the rules (handled separately — never fail for these here):
- "residential", "house cleaning", "home cleaning".

Only fail on the company's ACTUAL primary industry matching a specific excluded industry.

Respond with JSON only, no other text:
{"result": "Passed" | "Failed", "industry": "the company's verified primary industry", "reason": "one sentence explanation"}

If there are no industry rules listed, return "Passed".`;

export async function auditIndustry(
  companyName: string,
  website: string | null,
  industry: string,
  exclusionIndustries: string,
  confidence: string,
  dataSources: string,
  replyText: string,
  leadEmail: string | null = null,
): Promise<IndustryAuditResult> {
  // 1. GLOBAL: Check if company itself is a cleaning/washing competitor.
  //    Includes the lead's email so we catch competitor-domain leads
  //    (e.g. paul@jantize.com) even when the enrichment step failed
  //    and we have no website or verified industry.
  const competitorCheck = checkCompanyForCompetitor(companyName, website, industry, leadEmail);
  if (competitorCheck) {
    return {
      result: "Failed",
      reason: `COMPETITOR: Company is a "${competitorCheck.keyword}" business (detected from company name/website/industry)`,
    };
  }

  // 2. REPLY TEXT: Check reply for residential/non-commercial inquiry
  const replyCheck = checkReplyForResidential(replyText);
  if (replyCheck) {
    return {
      result: replyCheck.result,
      reason: `Lead's reply asks about "${replyCheck.keyword}" cleaning`,
    };
  }

  if (!exclusionIndustries?.trim()) {
    return { result: "Passed", reason: "No exclusion industries defined for this client" };
  }

  if (!companyName?.trim() && !industry?.trim()) {
    return { result: "Passed", reason: "No company or industry data available" };
  }

  // Strip residential-related lines from exclusion text — handled separately by reply check
  const cleanedExclusions = exclusionIndustries
    .split("\n")
    .filter((line) => {
      const lower = line.toLowerCase().trim();
      // Remove lines that are only about residential
      if (lower.startsWith("residential")) return false;
      if (lower === "house cleaning" || lower === "home cleaning") return false;
      return true;
    })
    .join("\n")
    .trim();

  if (!cleanedExclusions) {
    return { result: "Passed", reason: "No non-residential exclusion industries defined" };
  }

  const userParts = [
    `Company: "${companyName}"`,
    website ? `Website: "${website}"` : null,
    leadEmail ? `Lead email (domain hints at the company): "${leadEmail}"` : null,
    industry ? `Provided industry (may be empty/unreliable): "${industry}"` : null,
    `Data confidence: ${confidence} | Sources: ${dataSources}`,
    `\nIndustry rules (EXCLUSION list): "${cleanedExclusions}"`,
  ].filter(Boolean).join("\n");

  try {
    const parsed = await geminiJSON<{ result?: string; reason?: string; industry?: string }>({
      system: SYSTEM_PROMPT,
      user: userParts,
      withSearch: true,
      maxTokens: 2048,
    });
    const result = parsed.result?.toLowerCase() === "failed" ? "Failed" : "Passed";
    return {
      result,
      reason: parsed.reason || (parsed.industry ? `Verified industry: ${parsed.industry}` : "No reason provided"),
    };
  } catch {
    // Default to Passed on a Gemini failure (conservative — don't drop a
    // potentially-good lead because of a transient API error).
    return { result: "Passed", reason: "Industry audit failed — defaulting to Passed" };
  }
}
