/**
 * Location audit — Gemini 2.5 Flash + Google Search grounding.
 *
 * Replaces the old gpt-4o-mini single-shot (which hallucinated distances on
 * lesser-known towns — e.g. flagged Belmont NC as 150 mi from Charlotte when
 * it's 12). Grounding lets the model look up the REAL driving distance and
 * disambiguate same-named towns (Belmont NC vs Belmont CA).
 *
 * Measures FROM the client's office anchor (hq_anchor) when available, and
 * also accepts the broader free-form service area (inclusion_locations).
 * ~20 mile / ~20 minute threshold, generous (default to Passed when in range).
 */

import { geminiJSON } from "@/lib/gemini";

interface LocationAuditResult {
  result: "Passed" | "Failed";
  reason: string;
}

const SYSTEM_PROMPT = `You are a geographic proximity auditor for a B2B commercial-services company. Decide if a LEAD is close enough to a CLIENT's service area to be worth pursuing.

You are given:
1. LEAD LOCATION — raw, possibly partial (city/state/address/zip from the lead's own reply or CRM).
2. CLIENT OFFICE ANCHOR — the client's office as "City, State" or a ZIP. This is the precise point to measure distance FROM. May be blank.
3. CLIENT SERVICE AREA — a broader free-form description (zips, counties, cities, or whole states). May span MULTIPLE regions — read all of it.

USE GOOGLE SEARCH to:
- Resolve the lead's location to a real place. Disambiguate same-named towns using any state given (e.g. "Belmont, NC" is near Charlotte NC, NOT Belmont CA).
- Look up the actual DRIVING distance/time between the lead and the client office anchor.

PASS if ANY of these is true:
- The lead is within ~20 miles OR ~20 minutes driving of the client office anchor.
- The lead's city/zip/county/state is contained in the client service area list (e.g. service area lists the lead's state or a county/zip that contains the lead).
Be GENEROUS — if there's any reasonable chance the lead is in range, PASS. A lead in the SAME city as the client passes. Never fail for "too vague" when a city + state are present.

FAIL only if the lead is clearly and obviously OUTSIDE all listed service areas AND more than ~20 miles / ~20 minutes from the office anchor.

Respond with JSON only, no other text:
{"result":"Passed"|"Failed","leadResolved":"City, ST","miles":number_or_null,"reason":"one sentence stating the resolved locations and approximate distance"}`;

export async function auditLocation(
  city: string | null,
  state: string | null,
  address: string | null,
  zip: string | null,
  inclusionLocations: string,
  confidence: string,
  hqAnchor: string | null = null,
): Promise<LocationAuditResult> {
  // No service-area constraint AND no anchor → nothing to measure against.
  if (!inclusionLocations?.trim() && !hqAnchor?.trim()) {
    return { result: "Passed", reason: "No service area or office anchor defined — all locations accepted" };
  }

  const leadLocation = [address, city, state, zip ? `ZIP: ${zip}` : null].filter(Boolean).join(", ");
  if (!leadLocation) {
    return { result: "Failed", reason: "No location data available for this lead" };
  }

  const userMessage = [
    `LEAD LOCATION: "${leadLocation}"`,
    `LEAD DATA CONFIDENCE: ${confidence}`,
    `CLIENT OFFICE ANCHOR: "${hqAnchor?.trim() || "(not provided)"}"`,
    `CLIENT SERVICE AREA: "${inclusionLocations?.trim() || "(not provided)"}"`,
  ].join("\n");

  try {
    const parsed = await geminiJSON<{ result?: string; reason?: string; leadResolved?: string; miles?: number | null }>({
      system: SYSTEM_PROMPT,
      user: userMessage,
      withSearch: true,
      maxTokens: 2048,
    });
    const result = parsed.result?.toLowerCase() === "passed" ? "Passed" : "Failed";
    return { result, reason: parsed.reason || "No reason provided" };
  } catch (e) {
    // A Gemini/infra error is NOT a geographic decision — don't reject the lead
    // for our API being down. Fail OPEN (default Passed), matching the industry
    // audit, with a clear reason so it's auditable and can be re-run.
    return { result: "Passed", reason: `Location audit unavailable — defaulted to Passed (${(e as Error).message.slice(0, 90)})` };
  }
}
