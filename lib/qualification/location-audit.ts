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
 *
 * The lead location comes from ONE source (the lead's reply, the signature in
 * the reply, or the CRM custom variables — see qualify-lead.ts) and is never a
 * mix of them. When it came from the reply, the lead's own message is passed
 * too, so the auditor reads their exact words (e.g. a UK postcode).
 */

import { geminiJSON } from "@/lib/gemini";

interface LocationAuditResult {
  result: "Passed" | "Failed";
  reason: string;
}

export interface LocationAuditInput {
  city: string | null;
  state: string | null;
  country: string | null;
  address: string | null;
  zip: string | null;
  /** Human label of where the location came from, e.g. "the lead's reply". */
  sourceLabel: string;
  /** The lead's own new message (only sent when the location came from it). */
  leadMessage?: string | null;
  confidence: string;
  inclusionLocations: string;
  hqAnchor: string | null;
}

const SYSTEM_PROMPT = `You are a geographic proximity auditor for a B2B commercial-services company. Decide if a LEAD is close enough to a CLIENT's service area to be worth pursuing.

You are given:
1. LEAD LOCATION — from ONE source, named in LOCATION SOURCE (the lead's own reply, the signature in their reply, or CRM data). When it came from the reply, the lead's own message is included — their words are authoritative.
2. CLIENT OFFICE ANCHOR — the client's office as "City, State" or a ZIP. This is the precise point to measure distance FROM. May be blank.
3. CLIENT SERVICE AREA — a broader free-form description (zips, counties, cities, or whole states). May span MULTIPLE regions — read all of it.

USE GOOGLE SEARCH to:
- Resolve the lead's location to a real place (ZIPs and non-US postcodes included). Disambiguate same-named towns using any state / country given (e.g. "Belmont, NC" is near Charlotte NC, NOT Belmont CA).
- Look up the actual DRIVING distance/time between the lead and the client office anchor.

PASS if ANY of these is true:
- The lead is within ~20 miles OR ~20 minutes driving of the client office anchor.
- The lead's city/zip/county/state/country is contained in the client service area list (e.g. service area lists the lead's state, a county/zip that contains the lead, or the lead's whole country such as "United States" / "nationwide"). Containment ALONE is enough — distance from the office does NOT matter then (a Massachusetts lead PASSES for a client whose service area is "United States", even if the office is in California).
Be GENEROUS within the client's country — if there's any reasonable chance the lead is in range, PASS. A lead in the SAME city as the client passes. Never fail for "too vague" when a city + state are present.

FAIL if:
- The lead is in a DIFFERENT COUNTRY from the client's office / service area (e.g. a UK postcode or "United Kingdom" for a US client) — always Failed, never generous.
- The lead is NOT contained in any listed service area AND is more than ~20 miles / ~20 minutes from the office anchor.

Respond with JSON only, no other text:
{"result":"Passed"|"Failed","leadResolved":"City, Region, Country","miles":number_or_null,"reason":"one sentence stating the resolved locations and approximate distance"}`;

export async function auditLocation(input: LocationAuditInput): Promise<LocationAuditResult> {
  const { city, state, country, address, zip, sourceLabel, leadMessage, confidence, inclusionLocations, hqAnchor } = input;

  // No service-area constraint AND no anchor → nothing to measure against.
  if (!inclusionLocations?.trim() && !hqAnchor?.trim()) {
    return { result: "Passed", reason: "No service area or office anchor defined — all locations accepted" };
  }

  const leadLocation = [address, city, state, zip ? `ZIP/postcode: ${zip}` : null, country].filter(Boolean).join(", ");
  if (!leadLocation) {
    return { result: "Failed", reason: "No location data available for this lead" };
  }

  const userMessage = [
    `LEAD LOCATION: "${leadLocation}"`,
    `LOCATION SOURCE: ${sourceLabel}`,
    leadMessage ? `LEAD'S OWN MESSAGE:\n"""${leadMessage.slice(0, 1200)}"""` : null,
    `LEAD DATA CONFIDENCE: ${confidence}`,
    `CLIENT OFFICE ANCHOR: "${hqAnchor?.trim() || "(not provided)"}"`,
    `CLIENT SERVICE AREA: "${inclusionLocations?.trim() || "(not provided)"}"`,
  ].filter(Boolean).join("\n");

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
