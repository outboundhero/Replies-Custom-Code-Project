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
import db from "@/lib/db";
import { updateRecord } from "@/lib/airtable";
import { logActivity, logError } from "@/lib/errors";
import { enrichLead, type EnrichedLeadData } from "./enrich-lead";
import { auditIndustry } from "./industry-audit";
import { auditLocation } from "./location-audit";
import { extractReplyLocation } from "./extract-reply-location";
import { stripQuotedHistory } from "./strip-quoted";
import { runCwAutoReroute, type ZipSource } from "@/lib/processing/cw-router";
import { geminiJSON } from "@/lib/gemini";

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
  /** Bison workspace the original reply came from — surfaced in the activity log. */
  bisonInstance?: string;
}

export async function qualifyLead(params: QualifyLeadParams): Promise<void> {
  const {
    campaignTag, companyName, city, state, address, googleMapsUrl, phone,
    leadEmail, replyText, replySubject, recordId, airtableBaseId, airtableTableId, bisonInstance,
  } = params;

  // 1. Get exclusion/inclusion rules from Supabase
  const { data: rules } = await supabase
    .from("client_qualifications")
    .select("exclusion_industries, inclusion_locations, hq_anchor")
    .eq("client_abbreviation", campaignTag)
    .single();

  const exclusionIndustries = rules?.exclusion_industries || "";
  const inclusionLocations = rules?.inclusion_locations || "";
  const hqAnchor = rules?.hq_anchor || "";

  // The LEAD's own new message only — the quoted history below carries OUR
  // client's original email (its signature, website, "janitorial" wording,
  // office address), which must never be mistaken for the lead's own identity.
  const leadMessage = stripQuotedHistory(replyText);

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
      replyText: leadMessage,
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
      leadMessage, leadEmail,
    );
  } catch (error) {
    await logError("tracked", "qualification-industry", (error as Error).message, {
      tag: campaignTag, record_id: recordId,
    });
    industryResult = { result: "Passed", reason: "Industry audit error — defaulting to Passed" };
  }

  // 4. Location audit. Priority of sources is now explicit:
  //   1. Anything the LEAD said in their reply (body or signature)
  //   2. The enriched location (website + signature parsing)
  //   3. CRM custom variables (built into enrichment as last resort)
  // Step 1 is a separate strict GPT extraction so the audit can't be
  // fooled into passing a lead on stale CRM city/state when the lead
  // themselves spelled out a different location.
  let locResolved = {
    city: enriched.city,
    state: enriched.state,
    address: enriched.address,
    zip: enriched.zip,
    source: `enrichment (${enriched.dataSources})`,
    confidence: enriched.confidence,
  };
  try {
    const replyLoc = await extractReplyLocation(leadMessage);
    if (replyLoc && (replyLoc.city || replyLoc.address)) {
      locResolved = {
        city: replyLoc.city || enriched.city,
        state: replyLoc.state || enriched.state,
        address: replyLoc.address || enriched.address,
        zip: replyLoc.zip || enriched.zip,
        source: `lead reply (${replyLoc.source})`,
        // Anything the lead wrote about themselves is high confidence.
        confidence: "high",
      };
    }
  } catch (error) {
    await logError("tracked", "qualification-extract-reply-location", (error as Error).message, {
      tag: campaignTag, record_id: recordId,
    });
    // Fall through with enrichment-only location.
  }

  let locationResult: { result: "Passed" | "Failed"; reason: string };
  try {
    locationResult = await auditLocation(
      locResolved.city, locResolved.state, locResolved.address, locResolved.zip,
      inclusionLocations, locResolved.confidence, hqAnchor,
    );
  } catch (error) {
    await logError("tracked", "qualification-location", (error as Error).message, {
      tag: campaignTag, record_id: recordId,
    });
    locationResult = { result: "Failed", reason: "Location audit error" };
  }

  // 5. Build qualification reason with enrichment context
  const reasons: string[] = [];
  if (industryResult.result === "Residential") {
    reasons.push(`RESIDENTIAL FLAG: ${industryResult.reason}`);
  } else if (industryResult.result === "Failed" && industryResult.reason.includes("reply asks about")) {
    reasons.push(`NON-COMMERCIAL FLAG: ${industryResult.reason}`);
  } else {
    reasons.push(`Industry audit: ${industryResult.reason}`);
  }
  reasons.push(`Location audit: ${locationResult.reason}`);
  reasons.push(`Location source: ${locResolved.source} → ${[locResolved.address, locResolved.city, locResolved.state, locResolved.zip].filter(Boolean).join(", ") || "(none)"}`);
  if (enriched.website) reasons.push(`Website: ${enriched.website}`);
  if (enriched.industry) reasons.push(`Verified industry: ${enriched.industry}`);
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

  // 7b. Also update Supabase replies table with audit results
  supabase.from("replies").update({
    industry_audit: industryResult.result,
    location_audit: locationResult.result,
    qualification_reason: qualificationReason,
    suggested_client: suggestedClients || null,
    updated_at: new Date().toISOString(),
  }).eq("airtable_record_id", recordId).then(({ error }) => {
    if (error) console.error("[qualification] Supabase update failed:", error.message);
  });

  // 7c. CW ZIP auto-router. For City Wide tags (CWSJ/CWSV/…), check whether
  // the lead's resolved ZIP belongs to a DIFFERENT CW client and, if so,
  // swap the client_tag + CC/template via the shared applyReallocate path
  // — exactly what the inbox Reallocate button does. For non-CW tags this
  // call just persists zip + zip_source for audit and returns.
  //
  // Runs AFTER the qualification update above so suggested_client from
  // cross-client matching has already landed; the CW router may overwrite
  // it with a more specific CW-routing note.
  try {
    const zipSource: ZipSource = !locResolved.zip
      ? "missing"
      : locResolved.source.startsWith("lead reply")
        ? "reply_signature"
        : "enrichment";
    await runCwAutoReroute({
      airtableRecordId: recordId,
      currentClientTag: campaignTag,
      leadZip: locResolved.zip || null,
      zipSource,
      leadEmail,
      bisonInstance: bisonInstance || "",
    });
  } catch (error) {
    await logError("tracked", "cw-auto-reroute", (error as Error).message, {
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
      bison_instance: bisonInstance,
    },
  });
}

/**
 * Find other clients where this lead would be a fit — Gemini 2.5 Flash +
 * Google Search grounding (real driving distances).
 *
 * Changes from the old version (each fixed a reported "missing suggestion"):
 *  - EXCLUDES churned clients (status "Churned") from the candidate pool — a
 *    churned client is gone and must never be suggested. Churned clients were
 *    ~half the pool (89 of 181) and, combined with the old 40-cap, crowded out
 *    valid active matches (the SFS @ index 84 / SBSSE @ index 180 misses).
 *  - No 40-candidate cap — EVERY non-churned client is sent to the model, so
 *    the right active client can always be chosen. (High safety ceiling only.)
 *  - Still does NOT filter to Active-only — inactive-but-not-churned clients
 *    (Paused / mis-marked, e.g. the JPCHI / DBSF misses) surface, flagged.
 *  - No 150-char truncation of inclusion_locations — large multi-state service
 *    areas were getting cut off and masking matches.
 *  - Uses each client's hq_anchor as the precise distance anchor.
 */
async function findFittingClients(
  excludeTag: string,
  enriched: EnrichedLeadData,
): Promise<string> {
  // Pull ALL statuses so we can both MARK non-active suggestions and EXCLUDE
  // churned clients entirely from the candidate pool.
  const { data: statusRows } = await supabase
    .from("client_status")
    .select("client_abbreviation, status");
  const activeTags = new Set<string>();
  const churnedTags = new Set<string>();
  for (const row of statusRows || []) {
    for (const part of String(row.client_abbreviation).split(/\s*[&\/,]+\s*/)) {
      const tag = part.trim().toUpperCase();
      if (!tag) continue;
      if (row.status === "Active") activeTags.add(tag);
      else if (row.status === "Churned") churnedTags.add(tag);
    }
  }

  const { data: allRules } = await supabase
    .from("client_qualifications")
    .select("client_abbreviation, exclusion_industries, inclusion_locations, hq_anchor");
  if (!allRules?.length) return "";

  // The set of REAL client tags (split combined abbreviations). Any AI-returned
  // tag not in here is a hallucination (e.g. "A") and gets dropped.
  const validTags = new Set<string>();
  for (const r of allRules) {
    for (const part of String(r.client_abbreviation).split(/\s*[&\/,]+\s*/)) {
      const t = part.trim().toUpperCase();
      if (t) validTags.add(t);
    }
  }

  // Only suggest ACTIVE + CLEANING clients (from the onboarding "Status" +
  // "Client Type" columns, synced into Turso client_meta). Non-Cleaning clients
  // (e.g. SI, DM4PM, SC, OH) and non-Active (Churned / Not Found / Paused) are
  // never suggested. Falls open (suggest as before) if client_meta isn't
  // populated yet, so this never blanks out suggestions pre-sync.
  const activeCleaning = new Set<string>();
  let haveMeta = false;
  try {
    const meta = await db.execute("SELECT client_tag, client_type, status FROM client_meta");
    haveMeta = meta.rows.length > 0;
    for (const m of meta.rows) {
      if (/^active$/i.test(String(m.status || "")) && /^cleaning$/i.test(String(m.client_type || ""))) {
        activeCleaning.add(String(m.client_tag).trim().toUpperCase());
      }
    }
  } catch { /* table not created yet → fall open */ }

  // Candidates: any OTHER client with a location signal that is Active+Cleaning.
  // (When meta isn't available, fall back to the old rule: non-churned.)
  const candidates = allRules.filter((r) => {
    const t = String(r.client_abbreviation).trim().toUpperCase();
    if (r.client_abbreviation === excludeTag) return false;
    if (!(r.inclusion_locations?.trim() || r.hq_anchor?.trim())) return false;
    if (haveMeta) return activeCleaning.has(t);
    return !churnedTags.has(t);
  });
  if (!candidates.length) return "";

  // Send EVERY non-churned candidate. The old slice(0, 40) silently dropped
  // valid active matches (SFS, SBSSE) that sorted past the first 40. The cap is
  // now just a high safety ceiling so the prompt stays bounded if the roster
  // grows very large — it sits well above the current ~92 non-churned clients.
  const clientsList = candidates.slice(0, 250)
    .map((r) => {
      const parts = [`- ${r.client_abbreviation} (${activeTags.has(String(r.client_abbreviation).trim().toUpperCase()) ? "Active" : "INACTIVE"})`];
      if (r.hq_anchor?.trim()) parts.push(`office: "${r.hq_anchor.trim()}"`);
      if (r.inclusion_locations?.trim()) parts.push(`serves: "${r.inclusion_locations.trim()}"`);
      if (r.exclusion_industries?.trim()) parts.push(`excludes: "${r.exclusion_industries.trim()}"`);
      return parts.join(" | ");
    })
    .join("\n");

  try {
    const parsed = await geminiJSON<{ fits?: Array<{ tag: string; reason: string }> }>({
      system: `You are a lead-to-client matching assistant for a B2B services company. Given a company's verified industry and location, determine which clients it is a good fit for.

A fit means BOTH:
1. The company is NOT in that client's excluded industries and is not residential.
2. The company is within ~20 miles / ~20 minutes driving of that client's office or service area.

USE GOOGLE SEARCH to verify real driving distances (disambiguate same-named towns by state). Read the FULL service area — it may span multiple regions.

Rules for the output:
- "tag" MUST be copied EXACTLY from a candidate's tag as listed (e.g. "SI", "DBSNJ"). NEVER invent, abbreviate, or shorten a tag (do not output "A").
- Return only the BEST 3 fits, most-fitting first.
- "reason" is a SHORT phrase, max 8 words, stating only the location match — e.g. "serves nationwide", "Fairfax County, VA", "~15 mi from office". No sentences.

Respond with JSON only: {"fits":[{"tag":"TAG","reason":"..."}]}. If none fit, {"fits":[]}.`,
      user: `Company: "${enriched.companyName}"
Industry: "${enriched.industry}"
Website: "${enriched.website || "unknown"}"
Location: "${enriched.city}, ${enriched.state}" (${enriched.address || "no address"}, ZIP: ${enriched.zip || "unknown"})

Candidate clients:
${clientsList}`,
      withSearch: true,
      maxTokens: 1024,
    });
    const fits = parsed.fits || [];
    // Keep only REAL tags (drops hallucinations like "A"), dedupe, active-first,
    // top 3, with a short trimmed reason → a concise "TAG (reason) · TAG (reason)".
    const seen = new Set<string>();
    const clean = fits
      .map((f) => ({ tag: String(f.tag || "").trim().toUpperCase(), reason: String(f.reason || "").replace(/\[inactive[^\]]*\]/i, "").trim() }))
      .filter((f) => f.tag && validTags.has(f.tag) && f.tag !== excludeTag.toUpperCase() && !seen.has(f.tag) && seen.add(f.tag))
      .sort((a, b) => (activeTags.has(b.tag) ? 1 : 0) - (activeTags.has(a.tag) ? 1 : 0))
      .slice(0, 3);
    if (!clean.length) return "";
    return clean.map((f) => {
      const reason = f.reason.length > 45 ? f.reason.slice(0, 45).replace(/[\s,.]+$/, "") + "…" : f.reason;
      const flag = activeTags.has(f.tag) ? "" : " ⚠";
      return reason ? `${f.tag}${flag} (${reason})` : `${f.tag}${flag}`;
    }).join(" · ");
  } catch {
    return "";
  }
}
