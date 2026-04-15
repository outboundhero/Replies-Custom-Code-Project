/**
 * Lead qualification orchestrator.
 * Runs after Airtable record creation for qualifying AI categories.
 * Non-blocking — errors are logged but never prevent the main webhook flow.
 */

import supabase from "@/lib/supabase";
import { updateRecord } from "@/lib/airtable";
import { logActivity, logError } from "@/lib/errors";
import { auditIndustry } from "./industry-audit";
import { auditLocation } from "./location-audit";

/** Personal/free email domains — don't extract website from these */
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.ca", "ymail.com", "rocketmail.com",
  "aol.com", "aim.com", "outlook.com", "hotmail.com", "hotmail.ca", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "att.net", "comcast.net", "xfinity.com",
  "verizon.net", "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net", "spectrum.net",
  "protonmail.com", "proton.me", "fastmail.com", "zoho.com", "gmx.com", "mail.com",
]);

function extractWebsite(email: string): string | null {
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const domain = parts[1].toLowerCase();
  if (PERSONAL_DOMAINS.has(domain)) return null;
  return domain;
}

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
  recordId: string;
  airtableBaseId: string;
  airtableTableId: string;
}

export async function qualifyLead(params: QualifyLeadParams): Promise<void> {
  const {
    campaignTag, companyName, city, state, address,
    leadEmail, recordId, airtableBaseId, airtableTableId,
  } = params;

  // 1. Check if client is active
  const { data: statusRow } = await supabase
    .from("client_status")
    .select("status")
    .eq("client_abbreviation", campaignTag)
    .single();

  if (!statusRow || statusRow.status !== "Active") {
    await logActivity("tracked", "qualification-skipped", {
      client_tag: campaignTag,
      lead_email: leadEmail,
      details: { reason: statusRow ? `Client status: ${statusRow.status}` : "Client not found in status table" },
    });
    return;
  }

  // 2. Get exclusion/inclusion rules
  const { data: rules } = await supabase
    .from("client_qualifications")
    .select("exclusion_industries, inclusion_locations")
    .eq("client_abbreviation", campaignTag)
    .single();

  const exclusionIndustries = rules?.exclusion_industries || "";
  const inclusionLocations = rules?.inclusion_locations || "";

  // 3. Industry audit
  let industryResult: { result: "Passed" | "Failed" | "Residential"; reason: string };
  try {
    const website = extractWebsite(leadEmail);
    industryResult = await auditIndustry(companyName, website, exclusionIndustries);
  } catch (error) {
    await logError("tracked", "qualification-industry", (error as Error).message, {
      tag: campaignTag, record_id: recordId,
    });
    industryResult = { result: "Passed", reason: "Industry audit error — defaulting to Passed" };
  }

  // 4. Location audit
  let locationResult: { result: "Passed" | "Failed"; reason: string };
  try {
    locationResult = await auditLocation(city, state, address, inclusionLocations);
  } catch (error) {
    await logError("tracked", "qualification-location", (error as Error).message, {
      tag: campaignTag, record_id: recordId,
    });
    locationResult = { result: "Failed", reason: "Location audit error" };
  }

  // 5. Build qualification reason
  const reasons: string[] = [];
  if (industryResult.result !== "Passed") reasons.push(`Industry: ${industryResult.reason}`);
  if (locationResult.result !== "Passed") reasons.push(`Location: ${locationResult.reason}`);
  const qualificationReason = reasons.length > 0 ? reasons.join(" | ") : "";

  // 6. Cross-client matching (if not a fit)
  let suggestedClients = "";
  if (industryResult.result !== "Passed" || locationResult.result !== "Passed") {
    try {
      suggestedClients = await findFittingClients(campaignTag, companyName, extractWebsite(leadEmail), city, state, address);
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
    };
    if (qualificationReason) updateFields["Qualification Reason"] = qualificationReason;
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
    },
  });
}

/**
 * Find other active clients where this lead would be a fit.
 * Uses a single GPT call for industry check, then location check for matches.
 */
async function findFittingClients(
  excludeTag: string,
  companyName: string,
  website: string | null,
  city: string | null,
  state: string | null,
  address: string | null,
): Promise<string> {
  // Get all active clients with their rules
  const { data: activeClients } = await supabase
    .from("client_status")
    .select("client_abbreviation")
    .eq("status", "Active")
    .neq("client_abbreviation", excludeTag);

  if (!activeClients?.length) return "";

  const tags = activeClients.map((c) => c.client_abbreviation);
  const { data: allRules } = await supabase
    .from("client_qualifications")
    .select("client_abbreviation, exclusion_industries, inclusion_locations")
    .in("client_abbreviation", tags);

  if (!allRules?.length) return "";

  // Single GPT call: check company against all clients' exclusions
  const clientsList = allRules
    .filter((r) => r.exclusion_industries?.trim())
    .map((r) => `- ${r.client_abbreviation}: excludes "${r.exclusion_industries}"`)
    .join("\n");

  if (!clientsList) return "";

  const fittingTags: string[] = [];

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
          {
            role: "system",
            content: `You are a business classification assistant. Given a company and multiple clients with their excluded industries, determine which clients this company could work with (i.e., the company does NOT fall under that client's excluded industries and is NOT residential).
Respond with JSON only: {"fits": ["TAG1", "TAG2"]}
If no clients fit, return {"fits": []}`,
          },
          {
            role: "user",
            content: `Company: "${companyName}"${website ? ` (website: ${website})` : ""}\n\nClients:\n${clientsList}`,
          },
        ],
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{"fits":[]}');
      const industryFits: string[] = parsed.fits || [];

      // For industry-fitting clients, check location
      for (const tag of industryFits) {
        const rule = allRules.find((r) => r.client_abbreviation === tag);
        if (!rule?.inclusion_locations?.trim()) {
          fittingTags.push(tag); // No location restriction
          continue;
        }
        const locResult = await auditLocation(city, state, address, rule.inclusion_locations);
        if (locResult.result === "Passed") {
          fittingTags.push(tag);
        }
      }
    }
  } catch {
    // Cross-client matching is best-effort
  }

  return fittingTags.join(", ");
}
