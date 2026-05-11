/**
 * Extract a city/state/address from the lead's REPLY text.
 *
 * Used as the top-priority location source for the qualification audit:
 *   1. lead's reply  ← this module
 *   2. email signature  ← parsed inline by enrich-lead
 *   3. Bison CRM custom variables  ← bottom of priority stack
 *
 * Why a dedicated step: enrich-lead's combined GPT call mixed industry +
 * location + website lookup, and was happy to fall back to CRM city/state
 * even when the lead's own reply body mentioned a different location.
 * That caused leads to PASS the location audit on stale CRM data while
 * the actual address (e.g. lead saying "we're in Indianapolis") would
 * have failed.
 *
 * Returns null when the reply doesn't surface a clear location — the
 * caller then falls back to enrichment / CRM.
 *
 * Strict by design: never invents a location. Looks at body text AND
 * signature blocks (anything after "--", "Regards", "Sent from my…").
 */

export interface ReplyLocation {
  city: string | null;
  state: string | null;     // 2-letter state abbreviation when possible
  address: string | null;   // street address when explicitly stated
  zip: string | null;
  /** Where in the reply the location came from — for audit/debug. */
  source: "body" | "signature";
}

export async function extractReplyLocation(
  replyText: string,
): Promise<ReplyLocation | null> {
  const text = (replyText || "").trim();
  if (!text) return null;
  if (!process.env.OPENAI_API_KEY) return null;

  const systemPrompt = [
    "You read a sales lead's email reply and extract any location they mention about THEMSELVES or their company.",
    "Respond with ONLY valid JSON in this shape:",
    `{ "city": string|null, "state": string|null, "address": string|null, "zip": string|null, "source": "body" | "signature" | null }`,
    "",
    "Rules:",
    `  - Return the location the lead says THEY are at. Do NOT return a location they're directing us to (e.g. "contact our LA office" — that's not where they are).`,
    `  - Look in BOTH the body of the reply AND any signature block (lines after "--", "Regards,", "Sent from my…", "Thanks,", or a name/title sign-off).`,
    `  - Set "source" = "body" when the location appears in the conversational body of the reply ("we're in Indianapolis", "our facility at 123 Main").`,
    `  - Set "source" = "signature" when the location is in a signature block at the end.`,
    `  - "state" is the 2-letter US abbreviation when the lead's location is in the US (e.g. "IN", not "Indiana").`,
    `  - "address" is a full street address ONLY if the lead spelled it out — do NOT compose addresses from city + state alone.`,
    `  - Return ALL fields null if the reply has no clear location of the lead's own.`,
    `  - DO NOT use the CRM data — that information is handled separately. You only see the reply text.`,
  ].join("\n");

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
          { role: "system", content: systemPrompt },
          { role: "user", content: text.slice(0, 3000) },
        ],
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<ReplyLocation> & { source?: string | null };
    const city = clean(parsed.city);
    const state = clean(parsed.state);
    const address = clean(parsed.address);
    const zip = clean(parsed.zip);
    const source = parsed.source === "body" || parsed.source === "signature" ? parsed.source : null;

    // Need at least city OR address — without one of those there's
    // nothing actionable for the audit.
    if (!city && !address) return null;
    if (!source) return null;

    return { city, state, address, zip, source };
  } catch {
    return null;
  }
}

function clean(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  if (!t) return null;
  if (t.toLowerCase() === "null") return null;
  return t;
}
