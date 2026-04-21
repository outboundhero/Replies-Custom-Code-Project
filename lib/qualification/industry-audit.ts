/**
 * GPT-based industry audit: checks if a company falls under excluded industries.
 * Uses enriched data (verified industry from web research) for higher accuracy.
 * Returns "Passed" (not excluded), "Failed" (excluded), or "Residential".
 *
 * IMPORTANT: "Residential" is ONLY returned when the lead's REPLY asks about
 * residential/house/home/apartment/Airbnb/food truck/farm cleaning.
 * Company data and website are NOT used for the residential check.
 */

interface IndustryAuditResult {
  result: "Passed" | "Failed" | "Residential";
  reason: string;
}

/** Lead's reply asks about residential cleaning → Residential */
const RESIDENTIAL_KEYWORDS = ["residential"];

/** Lead's reply asks about these → Failed (not a fit) */
const FAILED_KEYWORDS = [
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
  const failMatch = FAILED_KEYWORDS.find((kw) => lower.includes(kw));
  if (failMatch) return { result: "Failed", keyword: failMatch };

  return null;
}

const SYSTEM_PROMPT = `You are a business classification assistant. Given a company's verified details and industry rules, determine if the company passes or fails the industry check.

The rules text can be one of two patterns:
1. EXCLUSION LIST (most common): Lists specific industries to exclude, e.g. "restaurants, retail, healthcare". → FAIL if the company IS in any excluded industry, PASS otherwise.
2. INCLUSION-ONLY (rare): Says something like "we only want to work with X" or "only accept X". → FAIL if the company is NOT in the specified industry, PASS only if it IS in that industry.

Read the rules text carefully to determine which pattern it follows, then evaluate accordingly.

IMPORTANT: Do NOT check for residential/house/home cleaning — that is handled separately. Only check against the industry rules provided.

You are given enriched data that may include a verified industry from web research. Trust this data — it has already been researched.

Respond with JSON only, no other text:
{"result": "Passed" | "Failed", "reason": "one sentence explanation"}

- "Passed" = company meets the industry criteria
- "Failed" = company does not meet the industry criteria

If there are no industry rules listed, return "Passed".`;

export async function auditIndustry(
  companyName: string,
  website: string | null,
  industry: string,
  exclusionIndustries: string,
  confidence: string,
  dataSources: string,
  replyText: string,
): Promise<IndustryAuditResult> {
  // Check reply text for residential/non-commercial inquiry FIRST
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

  const userParts = [
    `Company: "${companyName}"`,
    website ? `Website: "${website}"` : null,
    industry ? `Verified industry: "${industry}"` : null,
    `Data confidence: ${confidence} | Sources: ${dataSources}`,
    `\nIndustry rules: "${exclusionIndustries}"`,
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
        max_tokens: 100,
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
