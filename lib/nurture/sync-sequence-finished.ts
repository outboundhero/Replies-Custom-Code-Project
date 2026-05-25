/**
 * Sync sequence-finished leads (Scenario 3) from EmailBison/OutboundHero.
 *
 * Strategy:
 * 1. For EVERY Bison instance in parallel (Promise.allSettled so one bad
 *    instance doesn't kill the others):
 *    a. Fetch ALL outbound campaigns (skip [Nurture] campaigns themselves).
 *    b. For each campaign, fetch leads with lead_campaign_status = "sequence_finished".
 *    c. Filter: keep only leads where overall_stats.replies === 0 (never replied) AND
 *       overall_stats.bounced != true (no bounce).
 *    d. Upsert into nurture_sequence_finished — sequence_finished_at = lead.updated_at,
 *       bison_instance = the instance the campaign came from.
 *
 * Eligibility = sequence_finished_at + 45 days, computed at query time.
 */

import supabase from "@/lib/supabase";
import { listCampaigns, listCampaignLeads, type OutboundLead } from "@/lib/outboundhero-api";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import { BISON_INSTANCES, type BisonInstanceKey } from "@/lib/bison-instances";

interface InstanceSyncResult {
  instance: BisonInstanceKey;
  campaignsScanned: number;
  candidatesFound: number;
  upserted: number;
  errors: string[];
}

export interface SyncResult {
  campaignsScanned: number;
  candidatesFound: number;
  upserted: number;
  errors: string[];
  /** Per-instance breakdown so the caller can spot one instance lagging. */
  perInstance: InstanceSyncResult[];
}

async function syncOneInstance(instanceKey: BisonInstanceKey): Promise<InstanceSyncResult> {
  const errors: string[] = [];
  let campaignsScanned = 0;
  let candidatesFound = 0;
  let upserted = 0;

  const allCampaigns = await listCampaigns(instanceKey);
  const outboundCampaigns = allCampaigns.filter((c) => {
    const name = c.name?.toLowerCase() || "";
    // Skip nurture campaigns themselves — we only sync FROM the main outbound
    return !name.includes("[nurture]") && c.type !== "nurture";
  });

  for (const campaign of outboundCampaigns) {
    campaignsScanned++;
    try {
      const leads = await listCampaignLeads(instanceKey, campaign.id, {
        leadCampaignStatus: "sequence_finished",
      });

      const candidates = leads.filter((lead) => {
        // Exclude bounced leads
        if (lead.status === "bounced") return false;
        // Exclude leads who replied
        const replies = lead.overall_stats?.replies ?? 0;
        if (replies > 0) return false;
        // Also check campaign-specific replies if available
        const campData = lead.lead_campaign_data;
        if (campData && !Array.isArray(campData)) {
          if ((campData.replies ?? 0) > 0) return false;
          if (campData.status === "bounced") return false;
        }
        return true;
      });

      candidatesFound += candidates.length;
      if (candidates.length === 0) continue;

      const clientTag = extractTagFromCampaignName(campaign.name) || null;

      const rows = candidates.map((lead: OutboundLead) => ({
        ob_lead_id: lead.id,
        ob_campaign_id: campaign.id,
        campaign_name: campaign.name,
        client_tag: clientTag,
        email: lead.email,
        first_name: lead.first_name,
        last_name: lead.last_name,
        company: lead.company,
        custom_variables: lead.custom_variables || [],
        sequence_finished_at: lead.updated_at,
        synced_at: new Date().toISOString(),
        bison_instance: instanceKey,
      }));

      // Unique constraint is (ob_lead_id, ob_campaign_id, bison_instance)
      // — see the Phase-1 SQL. Without bison_instance in the conflict key,
      // two instances issuing the same numeric IDs would overwrite each
      // other.
      const { error } = await supabase
        .from("nurture_sequence_finished")
        .upsert(rows, { onConflict: "ob_lead_id,ob_campaign_id,bison_instance" });

      if (error) {
        errors.push(`[${instanceKey}] Campaign ${campaign.id} (${campaign.name}): ${error.message}`);
      } else {
        upserted += rows.length;
        // Fire-and-forget ESP detection on the freshly-inserted rows.
        // Doesn't block the sync; backfill-esp.ts script picks up any
        // misses on the next pass.
        import("@/lib/email-guard").then(({ lookupEmailHost }) => {
          for (const r of rows) {
            if (!r.email) continue;
            lookupEmailHost(r.email).then((host) => {
              if (!host) return;
              supabase.from("nurture_sequence_finished")
                .update({ esp: host })
                .eq("ob_lead_id", r.ob_lead_id)
                .eq("ob_campaign_id", r.ob_campaign_id)
                .eq("bison_instance", instanceKey)
                .then(({ error: espErr }) => {
                  if (espErr) console.error("[sync-sequence-finished] esp update failed:", espErr.message);
                });
            }).catch((e) => console.error("[sync-sequence-finished] esp lookup failed:", e));
          }
        });
      }
    } catch (e) {
      errors.push(`[${instanceKey}] Campaign ${campaign.id} (${campaign.name}): ${(e as Error).message}`);
    }
  }

  return { instance: instanceKey, campaignsScanned, candidatesFound, upserted, errors };
}

export async function syncSequenceFinished(): Promise<SyncResult> {
  // Fan out across every Bison instance in parallel. allSettled means a
  // single instance being down (bad token, network blip, etc.) only
  // affects its own result — the others still complete.
  const settled = await Promise.allSettled(
    BISON_INSTANCES.map((i) => syncOneInstance(i.key)),
  );

  const perInstance: InstanceSyncResult[] = [];
  const errors: string[] = [];
  let campaignsScanned = 0;
  let candidatesFound = 0;
  let upserted = 0;

  settled.forEach((s, idx) => {
    const key = BISON_INSTANCES[idx].key;
    if (s.status === "fulfilled") {
      perInstance.push(s.value);
      campaignsScanned += s.value.campaignsScanned;
      candidatesFound += s.value.candidatesFound;
      upserted += s.value.upserted;
      errors.push(...s.value.errors);
    } else {
      const msg = (s.reason as Error)?.message || "unknown";
      const fail: InstanceSyncResult = {
        instance: key,
        campaignsScanned: 0,
        candidatesFound: 0,
        upserted: 0,
        errors: [`[${key}] instance sync failed: ${msg}`],
      };
      perInstance.push(fail);
      errors.push(...fail.errors);
    }
  });

  return { campaignsScanned, candidatesFound, upserted, errors, perInstance };
}
