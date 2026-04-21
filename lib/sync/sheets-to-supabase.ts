/**
 * Sync Google Sheets data to Supabase.
 * Fetches Client Tracker + Onboarding Form and upserts into Supabase tables.
 *
 * Handles combined abbreviations in sheets (e.g. "JPDFW & JPK", "JPAR / JPSWM")
 * by splitting them into individual rows so each tag can be looked up directly.
 */

import supabase from "@/lib/supabase";
import { fetchClientTracker, fetchOnboardingForm } from "@/lib/google-sheets";

interface SyncResult {
  statusCount: number;
  qualificationCount: number;
}

/** Split combined abbreviations like "JPDFW & JPK" or "JPAR / JPSWM" into individual tags */
function splitAbbreviations(raw: string): string[] {
  return raw
    .split(/[&\/,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Client tags where qualification rules have been manually overridden in Supabase.
 * The Google Sheets sync will NOT overwrite these — changes must be made directly in Supabase.
 * Add client tags here when their Supabase qualification rules differ from the Google Sheet.
 */
const MANUAL_OVERRIDE_TAGS = new Set(["QP"]);

export async function syncAll(): Promise<SyncResult> {
  const now = new Date().toISOString();

  // 1. Sync client status — split combined abbreviations, last row wins per tag
  const trackerRows = await fetchClientTracker();
  const statusMap = new Map<string, { client_abbreviation: string; status: string; synced_at: string }>();
  for (const r of trackerRows) {
    const tags = splitAbbreviations(r.clientAbbreviation);
    for (const tag of tags) {
      statusMap.set(tag, { client_abbreviation: tag, status: r.status, synced_at: now });
    }
  }
  const statusRecords = [...statusMap.values()];

  if (statusRecords.length > 0) {
    const { error: statusError } = await supabase
      .from("client_status")
      .upsert(statusRecords, { onConflict: "client_abbreviation" });

    if (statusError) throw new Error(`Failed to sync client_status: ${statusError.message}`);
  }

  // 2. Sync qualification rules — split combined abbreviations, last row wins per tag
  //    Skip clients with manual overrides (their rules are managed directly in Supabase)
  const formRows = await fetchOnboardingForm();
  const qualMap = new Map<string, { client_abbreviation: string; exclusion_industries: string; inclusion_locations: string; synced_at: string }>();
  for (const r of formRows) {
    const tags = splitAbbreviations(r.clientAbbreviation);
    for (const tag of tags) {
      if (MANUAL_OVERRIDE_TAGS.has(tag)) continue; // Skip manually overridden clients
      qualMap.set(tag, {
        client_abbreviation: tag,
        exclusion_industries: r.exclusionIndustries,
        inclusion_locations: r.inclusionLocations,
        synced_at: now,
      });
    }
  }
  const qualRecords = [...qualMap.values()];

  if (qualRecords.length > 0) {
    const { error: qualError } = await supabase
      .from("client_qualifications")
      .upsert(qualRecords, { onConflict: "client_abbreviation" });

    if (qualError) throw new Error(`Failed to sync client_qualifications: ${qualError.message}`);
  }

  return {
    statusCount: statusRecords.length,
    qualificationCount: qualRecords.length,
  };
}
