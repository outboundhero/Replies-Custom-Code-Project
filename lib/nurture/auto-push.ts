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
import { attachLeadsToCampaign, findLeadByEmail, createLeadsInInstance, type CreateLeadInput } from "@/lib/outboundhero-api";
import { effectiveEsp, type Esp } from "@/lib/nurture/esp";
import { getChurnedTags } from "@/lib/churn";
import { getClientInstances } from "@/lib/nurture/group-routing";
import { getCampaignMap, getMapConfirmedAt, pickFromMap } from "@/lib/nurture/campaign-map";
import { isPersonalDomain } from "@/lib/processing/personal-domains";
import { getInstanceLeadIds, recordInstanceLeads } from "@/lib/nurture/instance-leads";
import { logActivity, logError } from "@/lib/errors";

const NURTURE_DAYS = 45;
const PER_CLIENT_CAP = 200;

const EXCLUDED_AI_CATEGORIES = [
  "Interested", "Meeting Request", "Meeting Set", "Do Not Contact",
  "Wrong Person", "Wrong Person (Change of Target)", "Not Interested",
  "Mailbox No Longer Active", "Automated Error Message",
  "Automated Catch-All Message", "Referral Given", "Internally Forwarded",
];

interface Candidate {
  source: "seq" | "reply" | "legacy";
  rowId: number;
  email: string;
  esp: Esp;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  obLeadId: number | null;       // id in the SOURCE instance
  sourceInstance: string | null; // where the lead currently lives
  custom_variables: Array<{ name: string; value: string }>;
  // Computed during routing:
  lane?: "b2b" | "b2c";
  instance?: string;
}

interface BucketResult {
  esp: Esp;
  instance: string;
  lane: "b2b" | "b2c";
  campaign: { id: number; name: string; bison_instance: string };
  requested: number;
  attached: number;
  error?: string;
}

export interface AutoPushResult {
  clientTag: string;
  scanned: number;
  perBucket: BucketResult[];
  totalAttached: number;
  // Id cursors so the caller can page through the ENTIRE pool without the
  // head-of-line block that unmappable-lane leads (e.g. B2C when only B2B is
  // mapped) used to cause: those rows keep added_at=null and, ordered oldest-
  // first, would jam the window forever. The cursor advances past everything
  // scanned, mappable or not.
  nextSeqAfterId: number;
  nextRepAfterId: number;
  nextLegAfterId: number;
  exhausted: boolean; // no rows scanned this batch from any source
  error?: string;
}

export async function runAutoPushForClient(
  clientTag: string,
  opts: { cap?: number; seqAfterId?: number; repAfterId?: number; legAfterId?: number } = {},
): Promise<AutoPushResult> {
  // Cron uses the conservative PER_CLIENT_CAP safety belt; the on-demand
  // "Route all ready" action passes a larger cap and loops until drained.
  const cap = Math.max(1, opts.cap ?? PER_CLIENT_CAP);
  const seqAfterId = Math.max(0, opts.seqAfterId ?? 0);
  const repAfterId = Math.max(0, opts.repAfterId ?? 0);
  const legAfterId = Math.max(0, opts.legAfterId ?? 0);
  const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result: AutoPushResult = { clientTag, scanned: 0, perBucket: [], totalAttached: 0, nextSeqAfterId: seqAfterId, nextRepAfterId: repAfterId, nextLegAfterId: legAfterId, exhausted: true };

  // GATE 1: the operator must have confirmed this client's target-campaign map.
  // Nothing is auto-picked — we send ONLY to campaigns chosen in the map.
  const confirmedAt = await getMapConfirmedAt(clientTag);
  if (!confirmedAt) { result.error = "target-campaign map not confirmed — select & confirm campaigns first"; return result; }

  // GATE 2: the client must have a group mapping (→ which B2B/B2C instances).
  const instances = await getClientInstances(clientTag);
  if (!instances) { result.error = "no group mapping — sync the group sheet"; return result; }

  // The confirmed map: (instance, esp) → target campaign.
  const map = await getCampaignMap(clientTag);
  if (map.length === 0) { result.error = "no campaigns mapped"; return result; }

  // 1. Pull eligible sequence_finished candidates.
  // ESP guard: only route leads whose mailbox provider is CONFIRMED from
  // Bison's tags (esp column populated by the backfill cron). Rows with
  // esp IS NULL would fall through effectiveEsp()'s consumer-domain
  // heuristic to the Google catch-all — dumping custom-domain Outlook/SEG
  // mailboxes into the Google nurture campaign. Hold them back until the
  // hourly ESP backfill stamps them; they become routable automatically.
  const { data: seqRows, error: seqErr } = await supabase
    .from("nurture_sequence_finished")
    .select("id, ob_lead_id, bison_instance, email, first_name, last_name, company, custom_variables, esp, sequence_finished_at, added_at, skipped")
    .eq("client_tag", clientTag)
    .is("added_at", null)
    .not("skipped", "is", true)
    .not("esp", "is", null)
    .lte("sequence_finished_at", cutoffIso)
    .gt("id", seqAfterId)
    .order("id", { ascending: true })
    .limit(cap);
  if (seqErr) {
    result.error = `seq fetch failed: ${seqErr.message}`;
    return result;
  }
  // Advance the seq cursor past everything scanned (mappable or not).
  if (seqRows && seqRows.length) result.nextSeqAfterId = Math.max(...seqRows.map((r) => r.id as number));

  // 2. Pull eligible reply-based candidates (soft_negative + OOO, safe).
  // Only after the seq source is drained for this page (remaining budget),
  // paged by its own id cursor.
  const remaining = Math.max(0, cap - (seqRows?.length ?? 0));
  let replyRows: Array<{ id: number; lead_id: number | null; bison_instance: string | null; lead_email: string; esp: string | null; first_name: string | null; last_name: string | null; company_name: string | null }> = [];
  if (remaining > 0) {
    const { data, error } = await supabase
      .from("replies")
      .select("id, lead_id, bison_instance, lead_email, first_name, last_name, company_name, esp")
      .eq("client_tag", clientTag)
      .eq("nurture_safety", "safe")
      .is("nurture_added_at", null)
      .not("nurture_skipped", "is", true)
      .not("esp", "is", null) // confirmed-ESP only — see seq query above
      .not("reply_we_got", "is", null).neq("reply_we_got", "")
      .not("reply_time", "is", null)
      .lte("reply_time", cutoffIso)
      .gt("id", repAfterId)
      .or(
        `ai_categorized_lead_category.is.null,ai_categorized_lead_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`
      )
      .order("id", { ascending: true })
      .limit(remaining);
    if (error) {
      result.error = `replies fetch failed: ${error.message}`;
      return result;
    }
    replyRows = (data || []) as typeof replyRows;
    if (replyRows.length) result.nextRepAfterId = Math.max(...replyRows.map((r) => r.id));
  }

  // 2b. Pull eligible legacy candidates (historical Airtable-imported
  // soft_negative + OOO leads), after seq + replies for this page. Same
  // eligibility shape as replies; legacy has no bison_instance column, so
  // sourceInstance is null and the lead is resolved/created in the target
  // instance like any cross-instance lead.
  const remainingLeg = Math.max(0, remaining - replyRows.length);
  let legacyRows: Array<{ id: number; ob_lead_id: number | null; lead_email: string; esp: string | null; first_name: string | null; last_name: string | null; company: string | null }> = [];
  if (remainingLeg > 0) {
    const { data, error } = await supabase
      .from("nurture_legacy_leads")
      .select("id, ob_lead_id, lead_email, esp, first_name, last_name, company")
      .eq("client_tag", clientTag)
      .eq("nurture_safety", "safe")
      .is("nurture_added_at", null)
      .not("nurture_skipped", "is", true)
      .not("esp", "is", null) // confirmed-ESP only — see seq query above
      .not("reply_at", "is", null)
      .lte("reply_at", cutoffIso)
      .gt("id", legAfterId)
      .or(
        `original_ai_category.is.null,original_ai_category.not.in.(${EXCLUDED_AI_CATEGORIES.map((c) => `"${c}"`).join(",")})`
      )
      .order("id", { ascending: true })
      .limit(remainingLeg);
    if (error) {
      result.error = `legacy fetch failed: ${error.message}`;
      return result;
    }
    legacyRows = (data || []) as typeof legacyRows;
    if (legacyRows.length) result.nextLegAfterId = Math.max(...legacyRows.map((r) => r.id));
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

  // 4. Partition candidates by (instance, esp) — the routing key. A lead's
  //    instance comes from its lane (B2B/B2C) within the client's group.
  const byBucket = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!c.instance) continue;
    const key = `${c.instance} ${c.esp}`;
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key)!.push(c);
  }

  // 5. For each (instance, esp) bucket: resolve the MAPPED target campaign,
  //    CREATE the leads in that instance (so they live in the right workspace),
  //    attach to the campaign, stamp added_at. Sequential per bucket to stay
  //    gentle on Bison; create + attach within a bucket are batched.
  for (const [key, items] of byBucket) {
    const [instance, esp] = key.split(" ") as [string, Esp];
    const lane: "b2b" | "b2c" = items[0]?.lane ?? "b2b";
    const target = pickFromMap(map, instance, esp);
    if (!target) {
      result.perBucket.push({
        esp, instance, lane,
        campaign: { id: 0, name: "(unmapped)", bison_instance: instance },
        requested: items.length, attached: 0,
        error: `no campaign mapped for ${esp} in ${instance} — pick one in Target Campaigns`,
      });
      continue;
    }
    const cName = target.campaign_name ?? "(mapped)";

    const emailToId = new Map<string, number>();

    // Same-instance shortcut: leads already living in the target instance keep
    // their existing id — no create/lookup needed. Only leads crossing
    // instances need resolving.
    for (const i of items) if (i.sourceInstance === instance && i.obLeadId) emailToId.set(i.email.toLowerCase(), i.obLeadId);
    let crossItems = items.filter((i) => !(i.sourceInstance === instance && i.obLeadId));

    // Reuse pre-placed instance ids (scripts/place-leads.ts records them in
    // nurture_instance_lead) — attach directly, skip create entirely.
    if (crossItems.length > 0) {
      const saved = await getInstanceLeadIds(instance, crossItems.map((i) => i.email));
      crossItems = crossItems.filter((i) => {
        const id = saved.get(i.email.toLowerCase());
        if (id) { emailToId.set(i.email.toLowerCase(), id); return false; }
        return true;
      });
    }

    // Create whatever's left in the TARGET instance (with custom variables).
    // Existing emails come back notReturned (Bison dedupes) → resolve via
    // findLeadByEmail. Newly-resolved ids are recorded for next time.
    const payloads: CreateLeadInput[] = crossItems.map((i) => ({
      email: i.email, first_name: i.first_name, last_name: i.last_name, company: i.company,
      custom_variables: i.custom_variables.length ? i.custom_variables : undefined,
    }));
    try {
      if (payloads.length > 0) {
      const cr = await createLeadsInInstance(instance, payloads);
      const newlyResolved: Array<{ email: string; id: number }> = [];
      for (const c of cr.created) { emailToId.set(c.email.toLowerCase(), c.ob_lead_id); newlyResolved.push({ email: c.email, id: c.ob_lead_id }); }
      const missing = cr.notReturned;
      if (missing.length > 0) {
        const CONC = 5; let idx = 0;
        await Promise.all(Array.from({ length: Math.min(CONC, missing.length) }, async () => {
          while (idx < missing.length) {
            const em = missing[idx++];
            try { const lead = await findLeadByEmail(instance, em); if (lead?.id) { emailToId.set(em.toLowerCase(), lead.id); newlyResolved.push({ email: em, id: lead.id }); } } catch { /* skip */ }
          }
        }));
      }
      if (newlyResolved.length) await recordInstanceLeads(instance, clientTag, newlyResolved);
      if (cr.errors.length) console.warn(`[auto-push:${clientTag}] create errors in ${instance}/${esp}:`, cr.errors);
      }
    } catch (e) {
      result.perBucket.push({
        esp, instance, lane, campaign: { id: target.campaign_id, name: cName, bison_instance: instance },
        requested: items.length, attached: 0, error: `create failed: ${(e as Error).message}`,
      });
      continue;
    }

    const resolved = items.filter((i) => emailToId.has(i.email.toLowerCase()));
    if (resolved.length === 0) {
      result.perBucket.push({
        esp, instance, lane, campaign: { id: target.campaign_id, name: cName, bison_instance: instance },
        requested: items.length, attached: 0, error: "no lead ids resolved in target instance",
      });
      continue;
    }

    // Attach to the mapped campaign in the target instance.
    let attached = 0;
    try {
      const r = await attachLeadsToCampaign(instance, target.campaign_id, resolved.map((i) => emailToId.get(i.email.toLowerCase())!), true);
      attached = r.attachedCount ?? (r.ok ? resolved.length : 0);
      if (!r.ok) {
        result.perBucket.push({
          esp, instance, lane, campaign: { id: target.campaign_id, name: cName, bison_instance: instance },
          requested: items.length, attached: 0, error: `attach failed: ${r.error}`,
        });
        continue;
      }
    } catch (e) {
      result.perBucket.push({
        esp, instance, lane, campaign: { id: target.campaign_id, name: cName, bison_instance: instance },
        requested: items.length, attached: 0, error: `attach failed: ${(e as Error).message}`,
      });
      continue;
    }

    // Stamp added_at + nurture_campaign_id (best-effort; Bison succeeded).
    const stamp = new Date().toISOString();
    const seqIds = resolved.filter((i) => i.source === "seq").map((i) => i.rowId);
    const replyIds = resolved.filter((i) => i.source === "reply").map((i) => i.rowId);
    const legacyIds = resolved.filter((i) => i.source === "legacy").map((i) => i.rowId);
    if (seqIds.length > 0) await supabase.from("nurture_sequence_finished").update({ added_at: stamp, nurture_campaign_id: target.campaign_id }).in("id", seqIds);
    if (replyIds.length > 0) await supabase.from("replies").update({ nurture_added_at: stamp, nurture_campaign_id: target.campaign_id }).in("id", replyIds);
    if (legacyIds.length > 0) await supabase.from("nurture_legacy_leads").update({ nurture_added_at: stamp, nurture_campaign_id: target.campaign_id }).in("id", legacyIds);

    result.perBucket.push({
      esp, instance, lane, campaign: { id: target.campaign_id, name: cName, bison_instance: instance },
      requested: items.length, attached,
    });
    result.totalAttached += attached;
  }

  // 7. Log activity so the operator sees this in Recent Activity.
  await logActivity("nurture-auto-push", result.totalAttached > 0 ? "auto-pushed" : "no-op", {
    client_tag: clientTag,
    details: {
      scanned: result.scanned,
      total_attached: result.totalAttached,
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

/** List every client tag that has opted into auto-push. */
export async function listAutoEnabledClients(): Promise<string[]> {
  // OPT-OUT model: every active client tag is auto-nurtured by default unless
  // explicitly disabled (auto_nurture_disabled=1). Drive off the full tag
  // universe (client_tags) so clients with no client_config row are included.
  const res = await db.execute({
    sql: `SELECT ct.tag AS client_tag
          FROM client_tags ct
          LEFT JOIN client_config cc ON cc.client_tag = ct.tag
          WHERE COALESCE(cc.auto_nurture_disabled, 0) = 0`,
    args: [],
  });
  const tags = res.rows.map((r) => r.client_tag as string);
  // Never auto-push for churned clients (Status=Churned + Churn Date).
  const churned = await getChurnedTags();
  return tags.filter((t) => !churned.has((t || "").toUpperCase()));
}
