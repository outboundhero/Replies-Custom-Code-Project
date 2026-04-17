/**
 * GPT-based industry audit: checks if a company falls under excluded industries.
 * Uses enriched data (verified industry from web research) for higher accuracy.
 * Returns "Passed" (not excluded), "Failed" (excluded), or "Residential".
 */

interface IndustryAuditResult {
  result: "Passed" | "Failed" | "Residential";
  reason: string;
}

const SYSTEM_PROMPT = `You are a business classification assistant. Given a company's verified details and a list of excluded industries/keywords, determine if the company operates in any excluded industry.

Also check if the company appears to be RESIDENTIAL — meaning they primarily serve residential customers (e.g., Airbnb cleaning, apartment cleaning, house cleaning, maid service, short-term rental cleaning, residential cleaning, home cleaning).

You are given enriched data that may include a verified industry from web research. Trust this data — it has already been researched.

Respond with JSON only, no other text:
{"result": "Passed" | "Failed" | "Residential", "reason": "one sentence explanation"}

- "Passed" = company does NOT operate in any excluded industry and is NOT residential
- "Failed" = company operates in one of the excluded industries
- "Residential" = company primarily serves residential customers

If there are no excluded industries listed, return "Passed" unless the company is residential.`;

export async function auditIndustry(
  companyName: string,
  website: string | null,
  industry: string,
  exclusionIndustries: string,
  confidence: string,
  dataSources: string,
): Promise<IndustryAuditResult> {
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

    const validResults = ["Passed", "Failed", "Residential"];
    const result = validResults.find((v) => v.toLowerCase() === parsed.result?.toLowerCase());

    return {
      result: (result as IndustryAuditResult["result"]) || "Passed",
      reason: parsed.reason || "No reason provided",
    };
  } catch {
    return { result: "Passed", reason: "Industry audit failed — defaulting to Passed" };
  }
}
