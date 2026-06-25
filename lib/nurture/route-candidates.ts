/**
 * Shared map-routing core. Takes a list of candidate leads (already tagged with
 * lane → instance + ESP) and pushes each into its mapped nurture campaign:
 * partition by (instance, ESP) → resolve the mapped campaign → create the lead
 * in the target instance if it's cross-instance → attach to the campaign.
 *
 * Extracted from runAutoPushForClient so multiple entry points can reuse it:
 *  - the "ready pool" auto-push (lib/nurture/auto-push.ts)
 *  - routing a source campaign's leads (app/api/nurture/route-from-campaign)
 *
 * It does NOT write to our DB — callers that have source rows to stamp pass an
 * `onAttached(campaignId, resolved)` callback (auto-push stamps added_at); the
 * source-campaign flow passes none (the source is a Bison campaign, not a DB row).
 */
import {
  attachLeadsToCampaign, findLeadByEmail, createLeadsInInstance, type CreateLeadInput,
} from "@/lib/outboundhero-api";
import { type Esp } from "@/lib/nurture/esp";
import { pickFromMap, type CampaignMapEntry } from "@/lib/nurture/campaign-map";
import { getInstanceLeadIds, recordInstanceLeads } from "@/lib/nurture/instance-leads";

export interface Candidate {
  source: "seq" | "reply" | "legacy" | "campaign";
  rowId: number;
  email: string;
  esp: Esp;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  obLeadId: number | null;       // id in the SOURCE instance
  sourceInstance: string | null; // where the lead currently lives
  custom_variables: Array<{ name: string; value: string }>;
  // Computed before routing:
  lane?: "b2b" | "b2c";
  instance?: string;
}

export interface BucketResult {
  esp: Esp;
  instance: string;
  lane: "b2b" | "b2c";
  campaign: { id: number; name: string; bison_instance: string };
  requested: number;
  attached: number;
  error?: string;
}

export interface RouteCandidatesResult {
  perBucket: BucketResult[];
  totalAttached: number;
}

export async function routeCandidates(
  clientTag: string,
  candidates: Candidate[],
  map: CampaignMapEntry[],
  opts: { onAttached?: (campaignId: number, resolved: Candidate[]) => Promise<void> } = {},
): Promise<RouteCandidatesResult> {
  const result: RouteCandidatesResult = { perBucket: [], totalAttached: 0 };

  // Partition by (instance, esp) — the routing key. A lead's instance comes from
  // its lane (B2B/B2C) within the client's group.
  const byBucket = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!c.instance) continue;
    const key = `${c.instance} ${c.esp}`;
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key)!.push(c);
  }

  for (const [key, items] of byBucket) {
    const [instance, esp] = key.split(" ") as [string, Esp];
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

    // Same-instance shortcut: leads already in the target instance keep their id.
    for (const i of items) if (i.sourceInstance === instance && i.obLeadId) emailToId.set(i.email.toLowerCase(), i.obLeadId);
    let crossItems = items.filter((i) => !(i.sourceInstance === instance && i.obLeadId));

    // Reuse pre-placed instance ids (nurture_instance_lead) — skip create.
    if (crossItems.length > 0) {
      const saved = await getInstanceLeadIds(instance, crossItems.map((i) => i.email));
      crossItems = crossItems.filter((i) => {
        const id = saved.get(i.email.toLowerCase());
        if (id) { emailToId.set(i.email.toLowerCase(), id); return false; }
        return true;
      });
    }

    // Create whatever's left in the TARGET instance (with custom variables).
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
        if (cr.errors.length) console.warn(`[route-candidates:${clientTag}] create errors in ${instance}/${esp}:`, cr.errors);
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

    // Let the caller stamp its own source rows (best-effort; Bison succeeded).
    if (opts.onAttached) await opts.onAttached(target.campaign_id, resolved);

    result.perBucket.push({
      esp, instance, lane, campaign: { id: target.campaign_id, name: cName, bison_instance: instance },
      requested: items.length, attached,
    });
    result.totalAttached += attached;
  }

  return result;
}
