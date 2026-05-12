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

const SYSTEM_PROMPT = `You are a business classification assistant. Given a company's verified details and industry rules, determine if the company passes or fails the industry check.

CRITICAL: These rules are ALWAYS an EXCLUSION LIST unless the text EXPLICITLY contains phrases like "we only want to work with", "only accept", or "we only want". A simple list of industries (e.g. "back of house kitchen cleaning") is ALWAYS an exclusion — it means EXCLUDE those industries, not "only accept" them.

How to evaluate:
- DEFAULT (exclusion): The rules list industries/keywords to EXCLUDE. → FAIL only if the company clearly operates in one of those specific excluded industries. PASS otherwise.
- ONLY if the text explicitly says "we only want" or "only accept": Treat as inclusion-only. → FAIL if the company is NOT in the specified industry.

IMPORTANT RULES:
- IGNORE any mention of "residential" in the rules — residential checks are handled separately. Do NOT fail a company for being residential.
- IGNORE any mention of "house cleaning" or "home cleaning" in the rules — these are handled separately.
- Only fail if the company's ACTUAL industry matches the excluded industries. A restaurant is NOT "residential" just because the exclusion list mentions residential.
- When in doubt, return "Passed".

You are given enriched data that may include a verified industry from web research. Trust this data.

Respond with JSON only, no other text:
{"result": "Passed" | "Failed", "reason": "one sentence explanation"}

- "Passed" = company does NOT operate in any excluded industry
- "Failed" = company clearly operates in an excluded industry

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
    industry ? `Verified industry: "${industry}"` : null,
    `Data confidence: ${confidence} | Sources: ${dataSources}`,
    `\nIndustry rules: "${cleanedExclusions}"`,
  ].filter(Boolean).join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userParts },
        ],
      }),
    });

    if (!response.ok) {
      return { result: "Passed", reason: "Industry audit API error — defaulting to Passed" };
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw) as { result: string; reason: string };

    const result = parsed.result?.toLowerCase() === "failed" ? "Failed" : "Passed";

    return {
      result,
      reason: parsed.reason || "No reason provided",
    };
  } catch {
    return { result: "Passed", reason: "Industry audit failed — defaulting to Passed" };
  }
}
