/**
 * Lead qualification orchestrator.
 * Runs after Airtable record creation for qualifying AI categories.
 * Non-blocking — errors are logged but never prevent the main webhook flow.
 *
 * Flow:
 * 1. Enrich lead data (GPT + web search for verified industry/location)
 * 2. Industry audit using enriched data
 * 3. Location audit using enriched data
 * 4. Cross-client matching if either audit fails
 * 5. Update Airtable + log activity
 */

import supabase from "@/lib/supabase";
import { updateRecord } from "@/lib/airtable";
import { logActivity, logError } from "@/lib/errors";
import { enrichLead, type EnrichedLeadData } from "./enrich-lead";
import { auditIndustry } from "./industry-audit";
import { auditLocation } from "./location-audit";

interface QualifyLeadParams {
  campaignTag: string;
  companyName: string;
  city: string;
  state: string;
  address: string;
  googleMapsUrl: string;
  phone: string;
  linkedin: string;
  leadEmail: string;
  replyText: string;
  replySubject: string;
  recordId: string;
  airtableBaseId: string;
  airtableTableId: string;
}

export async function qualifyLead(params: QualifyLeadParams): Promise<void> {
  const {
    campaignTag, companyName, city, state, address, googleMapsUrl, phone,
    leadEmail, replyText, replySubject, recordId, airtableBaseId, airtableTableId,
  } = params;

  // 1. Get exclusion/inclusion rules from Supabase
  const { data: rules } = await supabase
    .from("client_qualifications")
    .select("exclusion_industries, inclusion_locations")
    .eq("client_abbreviation", campaignTag)
    .single();

  const exclusionIndustries = rules?.exclusion_industries || "";
  const inclusionLocations = rules?.inclusion_locations || "";

  // 2. Enrich lead data (GPT + web search)
  let enriched: EnrichedLeadData;
  try {
    enriched = await enrichLead({
      companyName,
      leadEmail,
      city,
      state,
      address,
      googleMapsUrl,
      phone: String(phone || ""),
      replyText,
    });
  } catch (error) {
    await logError("tracked", "qualification-enrich", (error as Error).message, {
      tag: campaignTag, record_id: recordId,
    });
    // Fall back to raw data
    enriched = {
      companyName, website: null, industry: "", city, state, address,
      zip: "", dataSources: "CRM only (enrichment failed)", confidence: "low",
    };
  }

  // 3. Industry audit with enriched data
  let industryResult: { result: "Passed" | "Failed" | "Residential"; reason: string };
  try {
    industryResult = await auditIndustry(
      enriched.companyName, enriched.website, enriched.industry,
      exclusionIndustries, enriched.confidence, enriched.dataSources,
    );
  } catch (error) {
    await logError("tracked", "qualification-industry", (error as Error).message, {
      tag: campaignTag, record_id: recordId,
    });
    industryResult = { result: "Passed", reason: "Industry audit error — defaulting to Passed" };
  }

  // 4. Location audit with enriched data
  let locationResult: { result: "Passed" | "Failed"; reason: string };
  try {
    locationResult = await auditLocation(
      enriched.city, enriched.state, enriched.address, enriched.zip,
      inclusionLocations, enriched.confidence,
    );
  } catch (error) {
    await logError("tracked", "qualification-location", (error as Error).message, {
      tag: campaignTag, record_id: recordId,
    });
    locationResult = { result: "Failed", reason: "Location audit error" };
  }

  // 5. Build qualification reason with enrichment context
  const reasons: string[] = [];
  if (enriched.website) reasons.push(`Website: ${enriched.website}`);
  if (enriched.industry) reasons.push(`Verified industry: ${enriched.industry}`);
  if (enriched.zip) reasons.push(`Verified location: ${enriched.city}, ${enriched.state} ${enriched.zip}`);
  reasons.push(`Industry audit: ${industryResult.reason}`);
  reasons.push(`Location audit: ${locationResult.reason}`);
  reasons.push(`Data: ${enriched.dataSources} (${enriched.confidence} confidence)`);
  const qualificationReason = reasons.join(" | ");

  // 6. Cross-client matching (if not a fit)
  let suggestedClients = "";
  if (industryResult.result !== "Passed" || locationResult.result !== "Passed") {
    try {
      suggestedClients = await findFittingClients(campaignTag, enriched);
    } catch (error) {
      await logError("tracked", "qualification-cross-client", (error as Error).message, {
        tag: campaignTag, record_id: recordId,
      });
    }
  }

  // 7. Update Airtable record with audit results
  try {
    const updateFields: Record<string, string> = {
      "Industry Audit": industryResult.result,
      "Location Audit": locationResult.result,
      "Qualification Reason": qualificationReason,
    };
    if (suggestedClients) updateFields["Suggested Client"] = suggestedClients;

    await updateRecord(airtableBaseId, airtableTableId, recordId, updateFields);
  } catch (error) {
    await logError("tracked", "qualification-airtable", (error as Error).message, {
      tag: campaignTag, record_id: recordId,
    });
  }

  // 8. Log activity
  await logActivity("tracked", "qualified", {
    client_tag: campaignTag,
    lead_email: leadEmail,
    details: {
      industry: industryResult.result,
      location: locationResult.result,
      reason: qualificationReason || "Fit",
      suggested: suggestedClients || undefined,
      enriched_confidence: enriched.confidence,
      enriched_industry: enriched.industry || undefined,
    },
  });
}

/**
 * Find other active clients where this lead would be a fit.
 * Uses enriched data (verified industry + location) for a single comprehensive GPT call.
 */
async function findFittingClients(
  excludeTag: string,
  enriched: EnrichedLeadData,
): Promise<string> {
  // Get all active clients with their rules
  const { data: allRules } = await supabase
    .from("client_qualifications")
    .select("client_abbreviation, exclusion_industries, inclusion_locations");

  if (!allRules?.length) return "";

  const otherRules = allRules.filter((r) => r.client_abbreviation !== excludeTag);
  if (!otherRules.length) return "";

  // Build a comprehensive prompt with enriched data + all clients
  const clientsList = otherRules
    .map((r) => {
      const parts = [`- ${r.client_abbreviation}`];
      if (r.exclusion_industries?.trim()) parts.push(`excludes: "${r.exclusion_industries}"`);
      if (r.inclusion_locations?.trim()) parts.push(`serves: "${r.inclusion_locations.slice(0, 150)}"`);
      return parts.join(" | ");
    })
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
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You are a lead-to-client matching assistant. Given a company's verified industry and location, determine which clients this company is a fit for.

A fit means BOTH:
1. Company is NOT in that client's excluded industries and is NOT residential
2. Company IS within approximately 5 miles of that client's service area

For each fitting client, provide a one-sentence reason explaining why this lead is a good fit for that specific client.

Respond with JSON only: {"fits": [{"tag": "TAG1", "reason": "one sentence why this lead fits this client"}, ...]}
If no clients fit, return {"fits": []}
Only include clients where BOTH industry and location match.`,
          },
          {
            role: "user",
            content: `Company: "${enriched.companyName}"
Industry: "${enriched.industry}"
Website: "${enriched.website || "unknown"}"
Location: "${enriched.city}, ${enriched.state}" (${enriched.address || "no address"}, ZIP: ${enriched.zip || "unknown"})

Clients:
${clientsList}`,
          },
        ],
      }),
    });

    if (!response.ok) return "";

    const data = await response.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{"fits":[]}');
    const fits: Array<{ tag: string; reason: string }> = parsed.fits || [];
    if (fits.length === 0) return "";
    return fits.map((f) => `${f.tag} (${f.reason})`).join(", ");
  } catch {
    return "";
  }
}
