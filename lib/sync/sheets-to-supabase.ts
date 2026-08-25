/**
 * Sync Google Sheets data to Supabase.
 * Client STATUS comes from the "Groups" tab (single source of truth); qualification
 * rules come from the Onboarding Form. Upserts into Supabase tables.
 *
 * Handles combined abbreviations in sheets (e.g. "JPDFW & JPK", "JPAR / JPSWM")
 * by splitting them into individual rows so each tag can be looked up directly.
 */

import supabase from "@/lib/supabase";
import db from "@/lib/db";
import { fetchClientGroupRecords, fetchChurnedFromGroups, fetchOnboardingForm } from "@/lib/google-sheets";

interface SyncResult {
  statusCount: number;
  qualificationCount: number;
}

/**
 * Split combined abbreviations like "JPDFW & JPK" or "JPAR / JPSWM" into
 * individual tags. Splits on "/", ",", " and ", and a SPACED " & " — but NOT a
 * bare "&", so single tags that contain an ampersand (K&LCS, JPC&A, TM&VC, L&D)
 * stay intact. (The old /[&\/,]+/ split "K&LCS" into "K"+"LCS", so its rules were
 * stored under the wrong tags and the audit found none.)
 */
function splitAbbreviations(raw: string): string[] {
  return raw
    .split(/\s*\/\s*|\s+&\s+|\s+and\s+|\s*,\s*/i)
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

  // 1. Sync client status FROM THE GROUPS TAB (single source of truth). A client
  //    is "Churned" only when Status=Churned AND its churn date has PASSED (same
  //    rule as the churn gate); everything else is "Active" — so a future-dated
  //    (scheduled) churn like JPWM still reads "Active" here. Records are already
  //    one-tag-per-row (combined abbreviations split upstream).
  const records = await fetchClientGroupRecords();
  const churnedNow = new Set((await fetchChurnedFromGroups()).map((c) => c.tag.toUpperCase()));
  const statusMap = new Map<string, { client_abbreviation: string; status: string; synced_at: string }>();
  for (const r of records) {
    statusMap.set(r.tag, { client_abbreviation: r.tag, status: churnedNow.has(r.tag) ? "Churned" : "Active", synced_at: now });
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
  const qualMap = new Map<string, { client_abbreviation: string; exclusion_industries: string; inclusion_locations: string; hq_anchor: string; synced_at: string }>();
  for (const r of formRows) {
    const tags = splitAbbreviations(r.clientAbbreviation);
    for (const tag of tags) {
      if (MANUAL_OVERRIDE_TAGS.has(tag)) continue; // Skip manually overridden clients
      qualMap.set(tag, {
        client_abbreviation: tag,
        exclusion_industries: r.exclusionIndustries,
        inclusion_locations: r.inclusionLocations,
        hq_anchor: r.hqAnchor,
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

  // 3. Sync onboarding Status + Client Type into Turso client_meta. The
  //    cross-client suggested-client matcher only suggests Active + Cleaning
  //    clients (Non-Cleaning like SI/DM4PM/SC/OH, and non-Active, are excluded).
  const metaMap = new Map<string, { tag: string; type: string; status: string }>();
  for (const r of formRows) {
    for (const tag of splitAbbreviations(r.clientAbbreviation)) {
      metaMap.set(tag.toUpperCase(), { tag: tag.toUpperCase(), type: r.clientType || "", status: r.status || "" });
    }
  }
  if (metaMap.size > 0) {
    await db.execute("CREATE TABLE IF NOT EXISTS client_meta (client_tag TEXT PRIMARY KEY, client_type TEXT, status TEXT, synced_at TEXT)");
    // Chunked upserts so a large roster doesn't exceed statement limits.
    const rows = [...metaMap.values()];
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      await db.batch(
        batch.map((m) => ({
          sql: "INSERT INTO client_meta (client_tag, client_type, status, synced_at) VALUES (?, ?, ?, ?) ON CONFLICT(client_tag) DO UPDATE SET client_type = excluded.client_type, status = excluded.status, synced_at = excluded.synced_at",
          args: [m.tag, m.type, m.status, now],
        })),
      );
    }
  }

  return {
    statusCount: statusRecords.length,
    qualificationCount: qualRecords.length,
  };
}
