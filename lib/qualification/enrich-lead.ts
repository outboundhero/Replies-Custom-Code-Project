/**
 * Lead data enrichment via GPT (company name / industry / location best guess).
 * Gathers company data from the reply + CRM before auditing. The industry audit
 * then verifies the industry with a live Google search (lib/qualification/
 * industry-audit.ts), and the location audit takes its location from the lead's
 * reply first, CRM second (lib/qualification/qualify-lead.ts).
 *
 * Note: this call used to pass OpenAI's `web_search_preview` tool, which the
 * Chat Completions API rejects (400) — every lead with a business email domain
 * silently fell back to CRM-only data from 2026-04-17 until it was removed.
 */
import { logError } from "@/lib/errors";

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
2. CRM custom variables (city/state/address fields) — LEAST RELIABLE, often outdated. Use ONLY when the reply yielded nothing.

DATA SOURCES — for INDUSTRY (in priority order):
1. What you know about the company's website domain (if it is a well-known business)
2. Email signature (titles, taglines, "Building Maintenance" etc.)
3. Company NAME — infer the industry from it when 1 & 2 give nothing
   (e.g. "Wealthquest Financial Svc" → "financial services";
   "Smith Dental Group" → "dental office"; "Oakwood Apartments" → "apartments").

YOUR TASKS:
1. Scan the ENTIRE reply text for any mention of the lead's location — body sentences, signature blocks, "Sent from my…" sigs included. If found, that IS the location, full stop.
2. If a company website domain is provided, use it as a clue to the industry (the industry audit verifies it with a live web search afterwards).
3. Cross-reference. NEVER use CRM city/state when the reply spelled out a different one — even when the CRM matches a "passing" service area (it might be wrong).
4. If no website domain is available (generic email like gmail), rely on reply + signature; CRM is a last-resort fallback.

IMPORTANT:
- Focus on determining the INDUSTRY accurately — this is critical for exclusion matching
- NEVER leave "industry" blank. If the website and signature yield nothing, give your BEST-GUESS industry from the company name (a short generic description like "financial services", "restaurant", "law firm"). Only leave it empty if the name is truly opaque (e.g. "ABC LLC").
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
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userParts.join("\n") },
        ],
      }),
    });

    if (!response.ok) {
      await reportEnrichFailure(`OpenAI ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return fallback(input, domain);
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw);

    return {
      companyName: parsed.company_name || input.companyName,
      // The lead's OWN email domain is the authoritative company website — never
      // let the model override it with a domain it inferred from the text (that
      // is how a quoted client signature became the "website" and mislabeled the
      // lead's industry). Only fall back to the model's website for personal
      // emails (gmail etc.) where there is no company domain.
      website: domain || parsed.website,
      industry: parsed.industry || "",
      city: parsed.city || input.city,
      state: parsed.state || input.state,
      address: parsed.address || input.address,
      zip: parsed.zip || "",
      dataSources: parsed.data_sources || "CRM only",
      confidence: (["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low") as EnrichedLeadData["confidence"],
    };
  } catch (e) {
    await reportEnrichFailure((e as Error).message);
    return fallback(input, domain);
  }
}

// Enrichment used to fail SILENTLY (an unsupported web-search option made every
// business-domain lead fall back to CRM-only data for months, unnoticed). Now
// failures are logged — at most once per 10 minutes per instance so an outage
// can't flood the Error Log.
let lastFailureLog = 0;
async function reportEnrichFailure(message: string): Promise<void> {
  if (Date.now() - lastFailureLog < 10 * 60_000) return;
  lastFailureLog = Date.now();
  try { await logError("tracked", "qualification-enrich", `Lead enrichment failed (audits fall back to CRM data): ${message}`, {}); } catch { /* never block the audit */ }
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
