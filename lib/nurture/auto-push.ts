/**
 * Auto-push helper — runs the same auto-route logic the UI button does,
 * but server-side from the cron. For each enabled client:
 *
 *   1. Pull every eligible "Ready" lead (from nurture_sequence_finished
 *      AND replies, both safety-filtered).
 *   2. Partition by ESP bucket (google / outlook / segs).
 *   3. Look up the canonical Bison nurture campaign per bucket
 *      ("(Cleaning Client)" suffix).
 *   4. attachLeadsToCampaign per bucket, in parallel.
 *   5. Stamp added_at + nurture_campaign_id on each row.
 *   6. Log activity so the operator can see what happened.
 *
 * Cap: 200 leads per client per run as a safety belt against runaway
 * pushes if a client suddenly has thousands of eligible leads.
 */

import supabase from "@/lib/supabase";
import db from "@/lib/db";
import { effectiveEsp } from "@/lib/nurture/esp";
import { getChurnedTags } from "@/lib/churn";
import { fetchNotYetLiveTags, NURTURE_GOLIVE_LAG_DAYS } from "@/lib/google-sheets";
import { getClientInstances } from "@/lib/nurture/group-routing";
import { getCampaignMap, getMapConfirmedAt } from "@/lib/nurture/campaign-map";
import { isPersonalDomain } from "@/lib/processing/personal-domains";
import { routeCandidates, type Candidate, type BucketResult } from "@/lib/nurture/route-candidates";
import { getSheetMeetingReadyEmails } from "@/lib/nurture/sheet-meeting-ready";
import { suppressedEmails } from "@/lib/service-area-changes/suppression";
import { logActivity, logError } from "@/lib/errors";
import { NURTURE_EXCLUDED_AI_CATEGORIES as EXCLUDED_AI_CATEGORIES } from "@/lib/nurture/excluded-categories";

const NURTURE_DAYS = 45;
const PER_CLIENT_CAP = 200;

/** A page cursor: the last row read, as "<time>|<id>" — the order every source is read in. */
function pageCursor(row: Record<string, unknown>, timeCol: string): string {
  return `${String(row[timeCol])}|${Number(row.id)}`;
}
function parseCursor(raw: string | undefined): { ts: string; id: number } | null {
  const i = (raw ?? "").lastIndexOf("|");
  if (i <= 0) return null;
  const ts = raw!.slice(0, i), id = Number(raw!.slice(i + 1));
  return ts && Number.isFinite(id) && !Number.isNaN(Date.parse(ts)) ? { ts, id } : null;
}
/** Rows after the cursor in (time, id) order — PostgREST's `or` for (time > ts) OR (time = ts AND id > id). */
function afterFilter(timeCol: string, c: { ts: string; id: number }): string {
  return `${timeCol}.gt."${c.ts}",and(${timeCol}.eq."${c.ts}",id.gt.${c.id})`;
}

// Candidate + BucketResult now live in lib/nurture/route-candidates.ts (shared
// with the source-campaign routing flow).

export interface AutoPushResult {
  clientTag: string;
  scanned: number;
  perBucket: BucketResult[];
  totalAttached: number;
  // Cursors so the caller can page through the ENTIRE pool without the
  // head-of-line block that unmappable-lane leads (e.g. B2C when only B2B is
  // mapped) used to cause: those rows keep added_at=null and, ordered oldest-
  // first, would jam the window forever. The cursor advances past everything
  // scanned, mappable or not. Each is "<time>|<id>" of the last row read (""
  // = from the start) — see pageCursor.
  nextSeqAfter: string;
  nextRepAfter: string;
  nextLegAfter: string;
  exhausted: boolean; // no rows scanned this batch from any source
  error?: string;
  /** "gate": a setup state that keeps this client out (map not confirmed, not live yet…) — expected.
   *  "failure": something broke (a read failed, the sheet couldn't be read) — it must be seen. */
  errorKind?: "gate" | "failure";
  // Candidates dropped this batch because the client's lead-tracking sheet marks
  // them "Meeting-Ready Lead" (delivered to the client — never re-nurture).
  sheetMeetingReadyExcluded?: number;
  // Candidates dropped (and taken off the queue) because the client removed them
  // for a service-area change.
  suppressedExcluded?: number;
}

export async function runAutoPushForClient(
  clientTag: string,
  opts: { cap?: number; seqAfter?: string; repAfter?: string; legAfter?: string } = {},
): Promise<AutoPushResult> {
  // Cron uses the conservative PER_CLIENT_CAP safety belt; the on-demand
  // "Route all ready" action passes a larger cap and loops until drained.
  const cap = Math.max(1, opts.cap ?? PER_CLIENT_CAP);
  const seqAfter = parseCursor(opts.seqAfter);
  const repAfter = parseCursor(opts.repAfter);
  const legAfter = parseCursor(opts.legAfter);
  const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result: AutoPushResult = { clientTag, scanned: 0, perBucket: [], totalAttached: 0, nextSeqAfter: opts.seqAfter ?? "", nextRepAfter: opts.repAfter ?? "", nextLegAfter: opts.legAfter ?? "", exhausted: true };

  // GATE 1: the operator must have confirmed this client's target-campaign map.
  // Nothing is auto-picked — we send ONLY to campaigns chosen in the map.
  const confirmedAt = await getMapConfirmedAt(clientTag);
  if (!confirmedAt) { result.error = "target-campaign map not confirmed — select & confirm campaigns first"; result.errorKind = "gate"; return result; }

  // GATE 2: the client must have a group mapping (→ which B2B/B2C instances).
  const instances = await getClientInstances(clientTag);
  if (!instances) { result.error = "no group mapping — sync the group sheet"; result.errorKind = "gate"; return result; }

  // GATE 2b — NURTURE GO-LIVE GATE: never nurture a client before it has launched
  // (+ the agreed lag). A pre-launch client (Go Live Date in the future) gets ZERO
  // nurture activity. FAIL CLOSED on a sheet-read error (skip, don't risk it).
  try {
    if ((await fetchNotYetLiveTags(NURTURE_GOLIVE_LAG_DAYS)).has(clientTag.toUpperCase())) {
      result.error = "not yet live (before go-live + lag)"; result.errorKind = "gate"; return result;
    }
  } catch (e) { result.error = `go-live check failed — skipped: ${(e as Error).message}`; result.errorKind = "failure"; return result; }

  // The confirmed map: (instance, esp) → target campaign.
  const map = await getCampaignMap(clientTag);
  if (map.length === 0) { result.error = "no campaigns mapped"; result.errorKind = "gate"; return result; }

  // 1. Pull eligible sequence_finished candidates.
  // ESP guard: only route leads whose mailbox provider is CONFIRMED from
  // Bison's tags (esp column populated by the backfill cron). Rows with
  // esp IS NULL would fall through effectiveEsp()'s consumer-domain
  // heuristic to the Google catch-all — dumping custom-domain Outlook/SEG
  // mailboxes into the Google nurture campaign. Hold them back until the
  // hourly ESP backfill stamps them; they become routable automatically.
  //
  // Paged by (sequence_finished_at, id), never by id alone: that walked the
  // table's ~5.5M rows in id order looking for this client's few pending ones
  // and timed out for big clients on every run — JPC routed nothing from Aug 14
  // to Oct 21, JPCI, FSD and CI the same. The time order is the one the
  // pending-queue index (client_tag, sequence_finished_at) serves.
  let seqQuery = supabase
    .from("nurture_sequence_finished")
    .select("id, ob_lead_id, bison_instance, email, first_name, last_name, company, custom_variables, esp, sequence_finished_at, added_at, skipped")
    .eq("client_tag", clientTag)
    .is("added_at", null)
    .not("skipped", "is", true)
    .not("esp", "is", null)
    .lte("sequence_finished_at", cutoffIso);
  if (seqAfter) seqQuery = seqQuery.or(afterFilter("sequence_finished_at", seqAfter));
  const { data: seqRows, error: seqErr } = await seqQuery
    .order("sequence_finished_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(cap);
  if (seqErr) {
    result.error = `seq fetch failed: ${seqErr.message}`;
    result.errorKind = "failure";
    return result;
  }
  // Advance the seq cursor past everything scanned (mappable or not).
  if (seqRows && seqRows.length) result.nextSeqAfter = pageCursor(seqRows[seqRows.length - 1], "sequence_finished_at");

  // 2. Pull eligible reply-based candidates (soft_negative + OOO, safe).
  // Only after the seq source is drained for this page (remaining budget),
  // paged by its own (reply_time, id) cursor — the pending-replies index's order.
  const remaining = Math.max(0, cap - (seqRows?.length ?? 0));
  let replyRows: Array<{ id: number; lead_id: number | null; bison_instance: string | null; lead_email: string; esp: string | null; first_name: string | null; last_name: string | null; company_name: string | null; reply_time: string }> = [];
  if (remaining > 0) {
    let repQuery = supabase
      .from("replies")
      .select("id, lead_id, bison_instance, lead_email, first_name, last_name, company_name, esp, reply_time")
      .eq("client_tag", clientTag)
      .eq("nurture_safety", "safe")
      .is("nurture_added_at", null)
      .not("nurture_skipped", "is", true)
      .not("esp", "is", null) // confirmed-ESP only — see seq query above
      .not("reply_we_got", "is", null).neq("reply_we_got", "")
      .not("reply_time", "is", null)
      .lte("reply_time", cutoffIso)
      .or(
        `ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`
      );
    if (repAfter) repQuery = repQuery.or(afterFilter("reply_time", repAfter));
    const { data, error } = await repQuery
      .order("reply_time", { ascending: true })
      .order("id", { ascending: true })
      .limit(remaining);
    if (error) {
      result.error = `replies fetch failed: ${error.message}`;
      result.errorKind = "failure";
      return result;
    }
    replyRows = (data || []) as typeof replyRows;
    if (replyRows.length) result.nextRepAfter = pageCursor(replyRows[replyRows.length - 1], "reply_time");
  }

  // 2b. Pull eligible legacy candidates (historical Airtable-imported
  // soft_negative + OOO leads), after seq + replies for this page. Same
  // eligibility shape as replies; legacy has no bison_instance column, so
  // sourceInstance is null and the lead is resolved/created in the target
  // instance like any cross-instance lead.
  const remainingLeg = Math.max(0, remaining - replyRows.length);
  let legacyRows: Array<{ id: number; ob_lead_id: number | null; lead_email: string; esp: string | null; first_name: string | null; last_name: string | null; company: string | null; reply_at: string }> = [];
  if (remainingLeg > 0) {
    let legQuery = supabase
      .from("nurture_legacy_leads")
      .select("id, ob_lead_id, lead_email, esp, first_name, last_name, company, reply_at")
      .eq("client_tag", clientTag)
      .eq("nurture_safety", "safe")
      .is("nurture_added_at", null)
      .not("nurture_skipped", "is", true)
      .not("esp", "is", null) // confirmed-ESP only — see seq query above
      .not("reply_at", "is", null)
      .lte("reply_at", cutoffIso)
      .or(
        `original_ai_category.is.null,original_ai_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`
      );
    if (legAfter) legQuery = legQuery.or(afterFilter("reply_at", legAfter));
    const { data, error } = await legQuery
      .order("reply_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(remainingLeg);
    if (error) {
      result.error = `legacy fetch failed: ${error.message}`;
      result.errorKind = "failure";
      return result;
    }
    legacyRows = (data || []) as typeof legacyRows;
    if (legacyRows.length) result.nextLegAfter = pageCursor(legacyRows[legacyRows.length - 1], "reply_at");
  }

  // Exhausted when no source returned a row this page.
  result.exhausted = (seqRows?.length ?? 0) === 0 && replyRows.length === 0 && legacyRows.length === 0;

  // 3. Normalise into Candidate[] with computed esp bucket + lane/instance.
  //    lane = personal email → B2C instance, else B2B instance (by group).
  const candidates: Candidate[] = [];
  for (const r of seqRows || []) {
    const email = r.email as string;
    if (!email) continue;
    const lane: "b2b" | "b2c" = isPersonalDomain(email) ? "b2c" : "b2b";
    candidates.push({
      source: "seq", rowId: r.id as number, email,
      esp: effectiveEsp(r.esp as string | null, email),
      first_name: (r.first_name as string | null) ?? null,
      last_name: (r.last_name as string | null) ?? null,
      company: (r.company as string | null) ?? null,
      obLeadId: (r.ob_lead_id as number | null) ?? null,
      sourceInstance: (r.bison_instance as string | null) ?? null,
      custom_variables: Array.isArray(r.custom_variables) ? (r.custom_variables as Array<{ name: string; value: string }>).filter((v) => v && v.name && v.value != null) : [],
      lane, instance: instances[lane],
    });
  }
  for (const r of replyRows) {
    if (!r.lead_email) continue;
    const lane: "b2b" | "b2c" = isPersonalDomain(r.lead_email) ? "b2c" : "b2b";
    candidates.push({
      source: "reply", rowId: r.id, email: r.lead_email,
      esp: effectiveEsp(r.esp, r.lead_email),
      first_name: r.first_name ?? null,
      last_name: r.last_name ?? null,
      company: r.company_name ?? null,
      obLeadId: r.lead_id ?? null,
      sourceInstance: r.bison_instance ?? null,
      custom_variables: [],
      lane, instance: instances[lane],
    });
  }
  for (const r of legacyRows) {
    if (!r.lead_email) continue;
    const lane: "b2b" | "b2c" = isPersonalDomain(r.lead_email) ? "b2c" : "b2b";
    candidates.push({
      source: "legacy", rowId: r.id, email: r.lead_email,
      esp: effectiveEsp(r.esp, r.lead_email),
      first_name: r.first_name ?? null,
      last_name: r.last_name ?? null,
      company: r.company ?? null,
      obLeadId: r.ob_lead_id ?? null,
      sourceInstance: null, // legacy has no source-instance column → resolve in target
      custom_variables: [],
      lane, instance: instances[lane],
    });
  }
  result.scanned = candidates.length;
  if (candidates.length === 0) return result;

  // 3b. Sheet-authoritative Meeting-Ready gate. The client's lead-tracking sheet
  // is the source of truth for what was DELIVERED to them as a hot/meeting-ready
  // lead, and it often disagrees with our stored category (edited sheets, legacy
  // leads not in `replies`). Never nurture a lead the sheet marks Meeting-Ready.
  // Only that category excludes — mere presence under Interested/Follow Up/etc.
  // does not. If the client has a sheet we can't read this run, skip the push
  // (fail closed) so we never re-target a delivered lead; it retries next tick.
  const sheetMR = await getSheetMeetingReadyEmails(clientTag);
  if (!sheetMR.ok) {
    result.error = "lead-tracking sheet unreadable — skipped this run to avoid re-nurturing Meeting-Ready leads";
    result.errorKind = "failure";
    return result;
  }
  let routable = candidates;
  if (sheetMR.emails.size) {
    routable = candidates.filter((c) => !sheetMR.emails.has((c.email || "").trim().toLowerCase()));
    result.sheetMeetingReadyExcluded = candidates.length - routable.length;
  }

  // Leads the client removed for a service-area change never route again —
  // and leave the queue (the queue's own skip flag) so they aren't re-read.
  let blocked: Set<string>;
  try { blocked = await suppressedEmails(clientTag); }
  catch (e) { result.error = `service-area block list unreadable — skipped this run: ${(e as Error).message}`; result.errorKind = "failure"; return result; }
  if (blocked.size) {
    const out = routable.filter((c) => blocked.has((c.email || "").trim().toLowerCase()));
    if (out.length) {
      routable = routable.filter((c) => !blocked.has((c.email || "").trim().toLowerCase()));
      const ids = (src: Candidate["source"]) => out.filter((c) => c.source === src).map((c) => c.rowId);
      if (ids("seq").length) await supabase.from("nurture_sequence_finished").update({ skipped: true }).in("id", ids("seq"));
      if (ids("reply").length) await supabase.from("replies").update({ nurture_skipped: true }).in("id", ids("reply"));
      if (ids("legacy").length) await supabase.from("nurture_legacy_leads").update({ nurture_skipped: true }).in("id", ids("legacy"));
      result.suppressedExcluded = out.length;
    }
  }
  if (routable.length === 0) return result;

  // 4+5. Route via the shared core: partition by (instance, esp) → create in
  // the target instance → attach to the mapped campaign. The onAttached
  // callback stamps our source rows (added_at + nurture_campaign_id) per bucket.
  const routed = await routeCandidates(clientTag, routable, map, {
    onAttached: async (campaignId, resolved) => {
      const stamp = new Date().toISOString();
      const seqIds = resolved.filter((i) => i.source === "seq").map((i) => i.rowId);
      const replyIds = resolved.filter((i) => i.source === "reply").map((i) => i.rowId);
      const legacyIds = resolved.filter((i) => i.source === "legacy").map((i) => i.rowId);
      if (seqIds.length > 0) await supabase.from("nurture_sequence_finished").update({ added_at: stamp, nurture_campaign_id: campaignId }).in("id", seqIds);
      if (replyIds.length > 0) await supabase.from("replies").update({ nurture_added_at: stamp, nurture_campaign_id: campaignId }).in("id", replyIds);
      if (legacyIds.length > 0) await supabase.from("nurture_legacy_leads").update({ nurture_added_at: stamp, nurture_campaign_id: campaignId }).in("id", legacyIds);
    },
  });
  result.perBucket = routed.perBucket;
  result.totalAttached = routed.totalAttached;

  // 7. Log activity so the operator sees this in Recent Activity.
  await logActivity("nurture-auto-push", result.totalAttached > 0 ? "auto-pushed" : "no-op", {
    client_tag: clientTag,
    details: {
      scanned: result.scanned,
      total_attached: result.totalAttached,
      sheet_meeting_ready_excluded: result.sheetMeetingReadyExcluded ?? 0,
      service_area_removed_excluded: result.suppressedExcluded ?? 0,
      per_bucket: result.perBucket.map((b) => ({
        esp: b.esp, instance: b.instance, lane: b.lane,
        requested: b.requested, attached: b.attached,
        campaign: b.campaign.name, error: b.error,
      })),
    },
  });
  for (const b of result.perBucket) {
    if (b.error) {
      await logError("nurture-auto-push", `${clientTag}/${b.esp}`, b.error);
    }
  }

  // 8. Stamp last_run_at on client_config so the UI can show the timestamp.
  await db.execute({
    sql: "UPDATE client_config SET auto_nurture_last_run_at = datetime('now') WHERE client_tag = ?",
    args: [clientTag],
  });

  return result;
}

/**
 * After a client's turn in the auto-route cron: keep whether it FAILED (not a
 * setup gate), so a client that silently routes nothing shows up — on the
 * Nurture page's Automation tab and, when it starts or the reason changes, in
 * the Error Log. A good run clears it. (JPC routed nothing from Aug 14 to Oct 21
 * and nothing anywhere said so.)
 */
export async function recordAutoPushHealth(clientTag: string, failure: string | null): Promise<void> {
  const cur = await db.execute({ sql: "SELECT auto_nurture_last_error, auto_nurture_failing_since FROM client_config WHERE client_tag = ?", args: [clientTag] }).catch(() => null);
  const row = cur?.rows[0] as { auto_nurture_last_error?: string | null; auto_nurture_failing_since?: string | null } | undefined;
  if (!failure) {
    if (row?.auto_nurture_failing_since) {
      await db.execute({ sql: "UPDATE client_config SET auto_nurture_last_error = NULL, auto_nurture_failing_since = NULL WHERE client_tag = ?", args: [clientTag] });
    }
    return;
  }
  const text = failure.slice(0, 500);
  if (!row?.auto_nurture_failing_since || row.auto_nurture_last_error !== text) {
    await logError("nurture-auto-push", `client:${clientTag}`, `auto-route failed — ${text}`).catch(() => undefined);
  }
  await db.execute({
    sql: "UPDATE client_config SET auto_nurture_last_error = ?, auto_nurture_failing_since = COALESCE(auto_nurture_failing_since, datetime('now')) WHERE client_tag = ?",
    args: [text, clientTag],
  });
}

/** List every client tag that has opted into auto-push. */
export async function listAutoEnabledClients(): Promise<string[]> {
  // OPT-OUT model: every active client tag is auto-nurtured by default unless
  // explicitly disabled (auto_nurture_disabled=1). Drive off the full tag
  // universe (client_tags) so clients with no client_config row are included.
  const res = await db.execute({
    sql: `SELECT ct.tag AS client_tag
          FROM client_tags ct
          LEFT JOIN client_config cc ON cc.client_tag = ct.tag
          WHERE COALESCE(cc.auto_nurture_disabled, 0) = 0
          ORDER BY ct.tag`,
    args: [],
  });
  const tags = res.rows.map((r) => r.client_tag as string);
  // Never auto-push for churned clients (Status=Churned + Churn Date).
  const churned = await getChurnedTags();
  return tags.filter((t) => !churned.has((t || "").toUpperCase()));
}
