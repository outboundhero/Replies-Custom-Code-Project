/**
 * Lead data enrichment via GPT with web search.
 * Gathers verified company data from multiple sources before auditing.
 *
 * Data sources (in order of reliability):
 * 1. Company website (via web search) — MOST RELIABLE
 * 2. Email signature from reply text — RELIABLE
 * 3. Custom variables from CRM — LEAST RELIABLE
 */

/** Personal/free email domains — don't extract website from these */
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.ca", "ymail.com", "rocketmail.com",
  "aol.com", "aim.com", "outlook.com", "hotmail.com", "hotmail.ca", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "att.net", "comcast.net", "xfinity.com",
  "verizon.net", "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net", "spectrum.net",
  "protonmail.com", "proton.me", "fastmail.com", "zoho.com", "gmx.com", "mail.com",
]);

export interface EnrichedLeadData {
  companyName: string;
  website: string | null;
  industry: string;
  city: string;
  state: string;
  address: string;
  zip: string;
  dataSources: string;
  confidence: "high" | "medium" | "low";
}

interface EnrichInput {
  companyName: string;
  leadEmail: string;
  city: string;
  state: string;
  address: string;
  googleMapsUrl: string;
  phone: string;
  replyText: string;
}

function extractDomain(email: string): string | null {
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const domain = parts[1].toLowerCase();
  if (PERSONAL_DOMAINS.has(domain)) return null;
  return domain;
}

const SYSTEM_PROMPT = `You are a lead data enrichment assistant for a commercial cleaning/janitorial sales company. Given raw lead data from multiple sources, produce the most accurate company profile.

DATA SOURCES — STRICT PRIORITY for LOCATION (city/state/address/zip):
1. The lead's REPLY TEXT — both body ("we're in Indianapolis", "our facility at 123 Main St") AND email signature block. THIS BEATS EVERYTHING ELSE for location. If the reply mentions any city/state/address of the lead's company, USE THAT.
2. Company website (only if the reply has no location info) — search the web for the domain.
3. CRM custom variables (city/state/address fields) — LEAST RELIABLE, often outdated. Use ONLY when the reply and website both yielded nothing.

DATA SOURCES — for INDUSTRY:
1. Company website (most reliable — search the web for the domain)
2. Email signature (titles, taglines, "Building Maintenance" etc.)
3. CRM data is rarely useful for industry

YOUR TASKS:
1. Scan the ENTIRE reply text for any mention of the lead's location — body sentences, signature blocks, "Sent from my…" sigs included. If found, that IS the location, full stop.
2. If a company website domain is provided, search the web for it and extract industry + address. Industry from the website always wins over signature.
3. Cross-reference. NEVER use CRM city/state when the reply spelled out a different one — even when the CRM matches a "passing" service area (it might be wrong).
4. If no website domain is available (generic email like gmail), rely on reply + signature; CRM is a last-resort fallback.

IMPORTANT:
- Focus on determining the INDUSTRY accurately — this is critical for exclusion matching
- Focus on determining the LOCATION accurately — this is critical for proximity matching
- If the company appears to be residential (house cleaning, maid service, Airbnb), note that in the industry field

Respond with JSON only, no other text:
{
  "company_name": "verified or best guess company name",
  "website": "domain.com or null",
  "industry": "specific industry description (e.g., 'medical office', 'church', 'restaurant', 'office building', 'school')",
  "city": "most accurate city",
  "state": "most accurate state abbreviation",
  "address": "most accurate full address or empty string",
  "zip": "zip code if found or empty string",
  "data_sources": "brief note on which sources provided the key data",
  "confidence": "high if website confirmed, medium if signature only, low if CRM only"
}`;

export async function enrichLead(input: EnrichInput): Promise<EnrichedLeadData> {
  const domain = extractDomain(input.leadEmail);

  const userParts: string[] = [
    `Company name (from CRM): "${input.companyName || "unknown"}"`,
  ];

  if (domain) {
    userParts.push(`Company email domain: "${domain}" (search this website for industry and address info)`);
  } else {
    userParts.push(`Email: "${input.leadEmail}" (generic/personal email — no company website available)`);
  }

  if (input.city || input.state || input.address) {
    userParts.push(`CRM location data: city="${input.city}", state="${input.state}", address="${input.address}"`);
  }

  if (input.googleMapsUrl) {
    userParts.push(`Google Maps URL: ${input.googleMapsUrl}`);
  }

  if (input.phone) {
    userParts.push(`Phone: ${input.phone}`);
  }

  if (input.replyText) {
    userParts.push(`\nReply text (check for email signature with address/website):\n"""${input.replyText.slice(0, 1500)}"""`);
  }

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
        max_tokens: 300,
        response_format: { type: "json_object" },
        tools: domain ? [{ type: "web_search_preview" }] : undefined,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userParts.join("\n") },
        ],
      }),
    });

    if (!response.ok) {
      return fallback(input, domain);
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw);

    return {
      companyName: parsed.company_name || input.companyName,
      website: parsed.website || domain,
      industry: parsed.industry || "",
      city: parsed.city || input.city,
      state: parsed.state || input.state,
      address: parsed.address || input.address,
      zip: parsed.zip || "",
      dataSources: parsed.data_sources || "CRM only",
      confidence: (["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low") as EnrichedLeadData["confidence"],
    };
  } catch {
    return fallback(input, domain);
  }
}

function fallback(input: EnrichInput, domain: string | null): EnrichedLeadData {
  return {
    companyName: input.companyName,
    website: domain,
    industry: "",
    city: input.city,
    state: input.state,
    address: input.address,
    zip: "",
    dataSources: "CRM only (enrichment failed)",
    confidence: "low",
  };
}
