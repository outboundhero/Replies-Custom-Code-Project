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

/** Keywords in the lead's reply that indicate a residential inquiry */
const RESIDENTIAL_KEYWORDS = [
  "residential",
  "house cleaning",
  "home cleaning",
  "home office",
  "food truck",
  "airbnb",
  "apartment unit",
  "apartment cleaning",
  "my house",
  "my home",
  "my apartment",
  "farm cleaning",
  "farm building",
];

/**
 * Check if the lead's reply is asking about residential/home cleaning.
 * Only the reply text matters — not company data or website.
 */
function isResidentialInquiry(replyText: string): string | null {
  if (!replyText) return null;
  const lower = replyText.toLowerCase();
  return RESIDENTIAL_KEYWORDS.find((kw) => lower.includes(kw)) || null;
}

const SYSTEM_PROMPT = `You are a business classification assistant. Given a company's verified details and a list of excluded industries/keywords, determine if the company operates in any excluded industry.

IMPORTANT: Do NOT check for residential/house/home cleaning — that is handled separately. Only check against the excluded industries list provided.

You are given enriched data that may include a verified industry from web research. Trust this data — it has already been researched.

Respond with JSON only, no other text:
{"result": "Passed" | "Failed", "reason": "one sentence explanation"}

- "Passed" = company does NOT operate in any excluded industry
- "Failed" = company operates in one of the excluded industries

If there are no excluded industries listed, return "Passed".`;

export async function auditIndustry(
  companyName: string,
  website: string | null,
  industry: string,
  exclusionIndustries: string,
  confidence: string,
  dataSources: string,
  replyText: string,
): Promise<IndustryAuditResult> {
  // Check reply text for residential inquiry FIRST (only source for residential)
  const residentialMatch = isResidentialInquiry(replyText);
  if (residentialMatch) {
    return {
      result: "Residential",
      reason: `Lead's reply asks about "${residentialMatch}" cleaning`,
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
    `\nExcluded industries/keywords: "${exclusionIndustries}"`,
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
