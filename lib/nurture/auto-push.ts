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
import { listCampaigns, attachLeadsToCampaign, findLeadByEmail } from "@/lib/outboundhero-api";
import { resolveInstanceForClient } from "@/lib/bison-instances";
import { effectiveEsp, isCanonicalNurtureCampaign, detectCampaignEsp, type Esp } from "@/lib/nurture/esp";
import { getChurnedTags } from "@/lib/churn";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
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
  source: "seq" | "reply";
  rowId: number;
  obLeadId: number | null;
  email: string;
  esp: Esp;
}

interface BucketResult {
  esp: Esp;
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
  error?: string;
}

export async function runAutoPushForClient(clientTag: string): Promise<AutoPushResult> {
  const cutoffIso = new Date(Date.now() - NURTURE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result: AutoPushResult = { clientTag, scanned: 0, perBucket: [], totalAttached: 0 };

  // 1. Pull eligible sequence_finished candidates.
  // ESP guard: only route leads whose mailbox provider is CONFIRMED from
  // Bison's tags (esp column populated by the backfill cron). Rows with
  // esp IS NULL would fall through effectiveEsp()'s consumer-domain
  // heuristic to the Google catch-all — dumping custom-domain Outlook/SEG
  // mailboxes into the Google nurture campaign. Hold them back until the
  // hourly ESP backfill stamps them; they become routable automatically.
  const { data: seqRows, error: seqErr } = await supabase
    .from("nurture_sequence_finished")
    .select("id, ob_lead_id, email, esp, sequence_finished_at, added_at, skipped")
    .eq("client_tag", clientTag)
    .is("added_at", null)
    .not("skipped", "is", true)
    .not("esp", "is", null)
    .lte("sequence_finished_at", cutoffIso)
    .order("sequence_finished_at", { ascending: true })
    .limit(PER_CLIENT_CAP);
  if (seqErr) {
    result.error = `seq fetch failed: ${seqErr.message}`;
    return result;
  }

  // 2. Pull eligible reply-based candidates (soft_negative + OOO, safe).
  const remaining = Math.max(0, PER_CLIENT_CAP - (seqRows?.length ?? 0));
  let replyRows: Array<{ id: number; lead_id: number | null; lead_email: string; esp: string | null }> = [];
  if (remaining > 0) {
    const { data, error } = await supabase
      .from("replies")
      .select("id, lead_id, lead_email, esp")
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
      )
      .order("reply_time", { ascending: true })
      .limit(remaining);
    if (error) {
      result.error = `replies fetch failed: ${error.message}`;
      return result;
    }
    replyRows = (data || []) as typeof replyRows;
  }

  // 3. Normalise into Candidate[] with computed esp bucket.
  const candidates: Candidate[] = [];
  for (const r of seqRows || []) {
    const email = r.email as string;
    if (!email) continue;
    candidates.push({
      source: "seq", rowId: r.id as number,
      obLeadId: (r.ob_lead_id as number | null) ?? null,
      email, esp: effectiveEsp(r.esp as string | null, email),
    });
  }
  for (const r of replyRows) {
    if (!r.lead_email) continue;
    candidates.push({
      source: "reply", rowId: r.id,
      obLeadId: r.lead_id ?? null,
      email: r.lead_email, esp: effectiveEsp(r.esp, r.lead_email),
    });
  }
  result.scanned = candidates.length;
  if (candidates.length === 0) return result;

  // 4. Look up the client's nurture campaigns + filter to canonical.
  const instanceKey = await resolveInstanceForClient(clientTag);
  let allCampaigns;
  try {
    // Include draft — the canonical nurture campaigns are often created in
    // draft and only resumed once leads are attached. We attach to draft/
    // active/paused; the resume step activates them.
    allCampaigns = await listCampaigns(instanceKey, { search: `${clientTag}:`, statuses: ["draft", "active", "paused"] });
  } catch (e) {
    result.error = `listCampaigns failed: ${(e as Error).message}`;
    return result;
  }
  const canonicalByEsp = new Map<Esp, typeof allCampaigns[number]>();
  for (const c of allCampaigns) {
    // EXACT client-tag match — Bison's search is fuzzy ("JPC:" can return
    // "JPC&A:" campaigns), so confirm the campaign's extracted tag IS this
    // client. Without this, JPC's leads could be pushed into JPC&A's campaign.
    if ((extractTagFromCampaignName(c.name) || "").toUpperCase() !== clientTag.toUpperCase()) continue;
    if (!isCanonicalNurtureCampaign(c.name)) continue;
    const esp = detectCampaignEsp(c.name);
    if (!esp) continue;
    if (canonicalByEsp.has(esp)) continue; // first match wins per bucket
    canonicalByEsp.set(esp, c);
  }

  // 5. Partition candidates by bucket.
  const byBucket = new Map<Esp, Candidate[]>();
  for (const c of candidates) {
    if (!byBucket.has(c.esp)) byBucket.set(c.esp, []);
    byBucket.get(c.esp)!.push(c);
  }

  // 6. For each bucket: resolve ob_lead_ids, attach, stamp.
  await Promise.all(
    Array.from(byBucket.entries()).map(async ([esp, items]) => {
      const campaign = canonicalByEsp.get(esp);
      if (!campaign) {
        result.perBucket.push({
          esp,
          campaign: { id: 0, name: "(missing)", bison_instance: instanceKey },
          requested: items.length, attached: 0,
          error: `no canonical "${clientTag}: ${esp} [Nurture] (Cleaning Client)" campaign on ${instanceKey}`,
        });
        return;
      }
      const cName = (campaign.name as string) ?? "(unnamed)";
      const cInstance = (instanceKey as string);

      // Resolve missing ob_lead_ids by email lookup (bounded concurrency).
      const needLookup = items.filter((i) => !i.obLeadId);
      if (needLookup.length > 0) {
        const CONC = 5;
        let idx = 0;
        await Promise.all(
          Array.from({ length: Math.min(CONC, needLookup.length) }, async () => {
            while (idx < needLookup.length) {
              const it = needLookup[idx++];
              try {
                const lead = await findLeadByEmail(instanceKey, it.email);
                if (lead?.id) it.obLeadId = lead.id;
              } catch { /* swallow — that item just won't push */ }
            }
          }),
        );
      }
      const resolvedItems = items.filter((i) => i.obLeadId);
      if (resolvedItems.length === 0) {
        result.perBucket.push({
          esp,
          campaign: { id: campaign.id, name: cName, bison_instance: cInstance },
          requested: items.length, attached: 0,
          error: "no resolvable OutboundHero lead IDs",
        });
        return;
      }

      // Attach to Bison.
      let attached = 0;
      try {
        const r = await attachLeadsToCampaign(
          instanceKey, campaign.id, resolvedItems.map((i) => i.obLeadId!), true
        );
        attached = (r as { added?: number; ok?: boolean }).added
          ?? ((r as { ok?: boolean }).ok ? resolvedItems.length : 0);
      } catch (e) {
        result.perBucket.push({
          esp,
          campaign: { id: campaign.id, name: cName, bison_instance: cInstance },
          requested: items.length, attached: 0,
          error: `attach failed: ${(e as Error).message}`,
        });
        return;
      }

      // Stamp added_at + nurture_campaign_id (best-effort; Bison succeeded).
      const seqIds = resolvedItems.filter((i) => i.source === "seq").map((i) => i.rowId);
      const replyIds = resolvedItems.filter((i) => i.source === "reply").map((i) => i.rowId);
      const stamp = new Date().toISOString();
      if (seqIds.length > 0) {
        await supabase.from("nurture_sequence_finished")
          .update({ added_at: stamp, nurture_campaign_id: campaign.id })
          .in("id", seqIds);
      }
      if (replyIds.length > 0) {
        await supabase.from("replies")
          .update({ nurture_added_at: stamp, nurture_campaign_id: campaign.id })
          .in("id", replyIds);
      }
      result.perBucket.push({
        esp,
        campaign: { id: campaign.id, name: cName, bison_instance: cInstance },
        requested: items.length, attached,
      });
      result.totalAttached += attached;
    }),
  );

  // 7. Log activity so the operator sees this in Recent Activity.
  await logActivity("nurture-auto-push", result.totalAttached > 0 ? "auto-pushed" : "no-op", {
    client_tag: clientTag,
    details: {
      scanned: result.scanned,
      total_attached: result.totalAttached,
      per_bucket: result.perBucket.map((b) => ({
        esp: b.esp, requested: b.requested, attached: b.attached,
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
