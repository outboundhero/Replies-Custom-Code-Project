import supabase from "@/lib/supabase";
import { logActivity, logError } from "@/lib/errors";
import { applyReallocate } from "@/lib/processing/apply-reallocate";

export type ZipSource = "reply_signature" | "enrichment" | "missing";

interface CwRerouteArgs {
  airtableRecordId: string;
  currentClientTag: string;
  leadZip: string | null;
  zipSource: ZipSource;
  leadEmail: string;
  bisonInstance: string;
}

interface CwRerouteResult {
  rerouted: boolean;
  newTag?: string;
  note: "not_cw" | "zip_missing" | "no_match" | "kept_original" | "rerouted";
}

/**
 * Pull every 5-digit token from the freeform inclusion_locations string.
 * Tolerates CSV, line breaks, prose mixed with cities/states.
 */
export function parseZipsFromInclusion(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  const matches = text.match(/\b\d{5}\b/g);
  return new Set(matches || []);
}

// In-process cache for the CW service-area sets. The query is cheap but a
// webhook burst can hit it many times in a second; cache for 60s so a freshly
// onboarded CW client goes live within a minute of the onboarding sync.
let cachedAreas: { value: Record<string, Set<string>>; expiresAt: number } | null = null;
const CW_AREAS_TTL_MS = 60 * 1000;

export async function loadCwServiceAreas(): Promise<Record<string, Set<string>>> {
  const now = Date.now();
  if (cachedAreas && cachedAreas.expiresAt > now) return cachedAreas.value;

  const { data, error } = await supabase
    .from("client_qualifications")
    .select("client_abbreviation, inclusion_locations")
    .ilike("client_abbreviation", "CW%");

  if (error) {
    console.error("[cw-router] loadCwServiceAreas failed:", error.message);
    return cachedAreas?.value ?? {};
  }

  const areas: Record<string, Set<string>> = {};
  for (const row of data || []) {
    const tag = (row.client_abbreviation as string)?.trim();
    if (!tag) continue;
    areas[tag] = parseZipsFromInclusion(row.inclusion_locations as string | null);
  }

  cachedAreas = { value: areas, expiresAt: now + CW_AREAS_TTL_MS };
  return areas;
}

/**
 * Decide if a CW row should be rerouted to another CW client based on ZIP.
 * Always stamps zip + zip_source onto the row. For CW rows it also writes
 * suggested_client to surface what the routing decision was.
 *
 * Non-blocking: errors are logged and swallowed so a CW router failure can
 * never break the qualification flow that called it.
 */
export async function runCwAutoReroute(args: CwRerouteArgs): Promise<CwRerouteResult> {
  const { airtableRecordId, currentClientTag, leadZip, zipSource, leadEmail, bisonInstance } = args;

  // Resolve the numeric replies.id once — applyReallocate keys off it, and
  // we use it for every subsequent update so duplicate rows (shouldn't
  // happen, but) only touch the one we care about.
  const { data: idRow } = await supabase
    .from("replies")
    .select("id")
    .eq("airtable_record_id", airtableRecordId)
    .single();
  const rowId = idRow?.id as number | undefined;
  if (!rowId) {
    console.warn("[cw-router] no replies row for airtable_record_id:", airtableRecordId);
    return { rerouted: false, note: "no_match" };
  }

  // Always persist the resolved ZIP for audit, even for non-CW rows.
  try {
    await supabase
      .from("replies")
      .update({
        zip: leadZip || null,
        zip_source: zipSource,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rowId);
  } catch (e) {
    console.warn("[cw-router] zip persist failed:", (e as Error).message);
  }

  if (!currentClientTag || !currentClientTag.toUpperCase().startsWith("CW")) {
    return { rerouted: false, note: "not_cw" };
  }

  if (!leadZip || zipSource === "missing") {
    await supabase
      .from("replies")
      .update({
        suggested_client: "ZIP unknown — manual review needed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", rowId);
    return { rerouted: false, note: "zip_missing" };
  }

  let areas: Record<string, Set<string>>;
  try {
    areas = await loadCwServiceAreas();
  } catch (e) {
    await logError("cw-router", "load-service-areas", (e as Error).message, {
      row_id: rowId, current_tag: currentClientTag,
    });
    return { rerouted: false, note: "no_match" };
  }

  let owner: string | null = null;
  for (const [tag, zips] of Object.entries(areas)) {
    if (zips.has(leadZip)) { owner = tag; break; }
  }

  if (!owner) {
    await supabase
      .from("replies")
      .update({
        suggested_client: `No City Wide Facility Solutions match for ZIP ${leadZip}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rowId);
    await logActivity("cw-router", "cw_no_match", {
      client_tag: currentClientTag,
      lead_email: leadEmail,
      details: { zip: leadZip, bison_instance: bisonInstance },
    });
    return { rerouted: false, note: "no_match" };
  }

  if (owner === currentClientTag) {
    return { rerouted: false, newTag: owner, note: "kept_original" };
  }

  // Owner is a different CW client — auto-swap.
  const result = await applyReallocate(rowId, owner);
  if (!result.ok) {
    await logError("cw-router", "apply-reallocate", result.error, {
      row_id: rowId, from: currentClientTag, to: owner, zip: leadZip,
    });
    return { rerouted: false, note: "no_match" };
  }

  // applyReallocate overwrites updated_at; write the audit note in a
  // follow-up update so both changes land.
  await supabase
    .from("replies")
    .update({
      suggested_client: `Auto-rerouted ${currentClientTag} → ${owner} by ZIP ${leadZip}`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", rowId);

  await logActivity("cw-router", "cw_auto_reroute", {
    client_tag: owner,
    lead_email: leadEmail,
    details: {
      from: currentClientTag,
      to: owner,
      zip: leadZip,
      zip_source: zipSource,
      bison_instance: bisonInstance,
    },
  });

  return { rerouted: true, newTag: owner, note: "rerouted" };
}
