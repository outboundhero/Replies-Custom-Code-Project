/**
 * Sync Google Sheets data to Supabase.
 * Fetches Client Tracker + Onboarding Form and upserts into Supabase tables.
 */

import supabase from "@/lib/supabase";
import { fetchClientTracker, fetchOnboardingForm } from "@/lib/google-sheets";

interface SyncResult {
  statusCount: number;
  qualificationCount: number;
}

export async function syncAll(): Promise<SyncResult> {
  // 1. Sync client status (deduplicate — last row wins for each abbreviation)
  const trackerRows = await fetchClientTracker();
  const statusMap = new Map<string, { client_abbreviation: string; status: string; synced_at: string }>();
  for (const r of trackerRows) {
    statusMap.set(r.clientAbbreviation, {
      client_abbreviation: r.clientAbbreviation,
      status: r.status,
      synced_at: new Date().toISOString(),
    });
  }
  const statusRecords = [...statusMap.values()];

  if (statusRecords.length > 0) {
    const { error: statusError } = await supabase
      .from("client_status")
      .upsert(statusRecords, { onConflict: "client_abbreviation" });

    if (statusError) throw new Error(`Failed to sync client_status: ${statusError.message}`);
  }

  // 2. Sync qualification rules (deduplicate — last row wins)
  const formRows = await fetchOnboardingForm();
  const qualMap = new Map<string, { client_abbreviation: string; exclusion_industries: string; inclusion_locations: string; synced_at: string }>();
  for (const r of formRows) {
    qualMap.set(r.clientAbbreviation, {
      client_abbreviation: r.clientAbbreviation,
      exclusion_industries: r.exclusionIndustries,
      inclusion_locations: r.inclusionLocations,
      synced_at: new Date().toISOString(),
    });
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
