/**
 * GPT-based location audit: checks if a lead is within ~20 miles / ~20 minutes of a client's service area.
 * Uses enriched data (verified address/zip from web research) for higher accuracy.
 */

interface LocationAuditResult {
  result: "Passed" | "Failed";
  reason: string;
}

const SYSTEM_PROMPT = `You are a geographic proximity assistant. Given a lead's location and a client's service area, determine if the lead is within approximately 20 miles or 20 minutes driving distance of the client's service area.

CRITICAL RULES:
- If a city and state are provided, that is ALWAYS enough information to determine proximity. NEVER say "too vague" or "cannot determine" when city + state are available. Use your geographic knowledge to estimate the distance.
- If the service area lists zip codes, check if the lead's city/zip is within ~20 miles of those zip codes.
- If the service area lists cities or counties, check if the lead's city is within ~20 miles of those areas.
- If the service area lists entire states, any location within that state counts as within the service area.
- Use your knowledge of US geography, zip codes, city locations, and driving distances.
- Be GENEROUS — if there's any reasonable chance the lead is within range, pass them. Err on the side of passing rather than failing.
- Only fail if the lead is clearly and obviously outside the 20-mile / 20-minute radius (e.g., different state with no nearby service area cities).

Respond with JSON only, no other text:
{"result": "Passed" | "Failed", "reason": "one sentence explanation with approximate distance"}

- "Passed" = lead is within approximately 20 miles / 20 minutes of the service area
- "Failed" = lead is clearly outside the service area (more than 20 miles away)`;

export async function auditLocation(
  city: string | null,
  state: string | null,
  address: string | null,
  zip: string | null,
  inclusionLocations: string,
  confidence: string,
): Promise<LocationAuditResult> {
  if (!inclusionLocations?.trim()) {
    return { result: "Passed", reason: "No inclusion locations defined — all locations accepted" };
  }

  const locationParts = [address, city, state, zip ? `ZIP: ${zip}` : null].filter(Boolean).join(", ");
  if (!locationParts) {
    return { result: "Failed", reason: "No location data available for this lead" };
  }

  const userMessage = `Lead location: "${locationParts}"\nData confidence: ${confidence}\nClient service area: "${inclusionLocations}"`;

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
      return { result: "Failed", reason: "Location audit API error" };
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw) as { result: string; reason: string };

    const result = parsed.result?.toLowerCase() === "passed" ? "Passed" : "Failed";
    return { result, reason: parsed.reason || "No reason provided" };
  } catch {
    return { result: "Failed", reason: "Location audit failed" };
  }
}
