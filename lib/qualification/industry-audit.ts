/**
 * GPT-based industry audit: checks if a company falls under excluded industries.
 * Returns "Passed" (not excluded), "Failed" (excluded), or "Residential".
 */

interface IndustryAuditResult {
  result: "Passed" | "Failed" | "Residential";
  reason: string;
}

const SYSTEM_PROMPT = `You are a business classification assistant. Given a company name, website, and any available details, determine if the company operates in any of the listed excluded industries or keywords.

Also check if the company appears to be RESIDENTIAL — meaning they primarily serve residential customers (e.g., Airbnb cleaning, apartment cleaning, house cleaning, maid service, short-term rental cleaning, residential cleaning, home cleaning).

Use your knowledge about the company. If the company name or website suggests a specific industry, use that knowledge.

Respond with JSON only, no other text:
{"result": "Passed" | "Failed" | "Residential", "reason": "one sentence explanation"}

- "Passed" = company does NOT operate in any excluded industry and is NOT residential
- "Failed" = company appears to operate in one of the excluded industries
- "Residential" = company appears to primarily serve residential customers

If there are no excluded industries listed or the exclusion list is empty, return "Passed" unless the company is residential.
If you cannot determine the company's industry from the name/website alone, lean toward "Passed" (benefit of the doubt).`;

export async function auditIndustry(
  companyName: string,
  website: string | null,
  exclusionIndustries: string
): Promise<IndustryAuditResult> {
  if (!exclusionIndustries?.trim()) {
    return { result: "Passed", reason: "No exclusion industries defined for this client" };
  }

  if (!companyName?.trim()) {
    return { result: "Passed", reason: "No company name available to check" };
  }

  const userMessage = [
    `Company: "${companyName}"`,
    website ? `Website: "${website}"` : null,
    `Excluded industries/keywords: "${exclusionIndustries}"`,
  ]
    .filter(Boolean)
    .join("\n");

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
          { role: "user", content: userMessage },
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
