/**
 * Sync sequence-finished leads (Scenario 3) from EmailBison/OutboundHero.
 *
 * Strategy:
 * 1. Fetch ALL outbound campaigns (skip [Nurture] campaigns themselves).
 * 2. For each campaign, fetch leads with lead_campaign_status = "sequence_finished".
 * 3. Filter: keep only leads where overall_stats.replies === 0 (never replied) AND
 *    overall_stats.bounced != true (no bounce).
 * 4. Upsert into nurture_sequence_finished — sequence_finished_at = lead.updated_at.
 *
 * Eligibility = sequence_finished_at + 45 days, computed at query time.
 */

import supabase from "@/lib/supabase";
import { listCampaigns, listCampaignLeads, type OutboundLead } from "@/lib/outboundhero-api";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";

interface SyncResult {
  campaignsScanned: number;
  candidatesFound: number;
  upserted: number;
  errors: string[];
}

export async function syncSequenceFinished(): Promise<SyncResult> {
  const errors: string[] = [];
  let campaignsScanned = 0;
  let candidatesFound = 0;
  let upserted = 0;

  const allCampaigns = await listCampaigns();
  const outboundCampaigns = allCampaigns.filter((c) => {
    const name = c.name?.toLowerCase() || "";
    // Skip nurture campaigns themselves — we only sync FROM the main outbound
    return !name.includes("[nurture]") && c.type !== "nurture";
  });

  for (const campaign of outboundCampaigns) {
    campaignsScanned++;
    try {
      const leads = await listCampaignLeads(campaign.id, {
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
      }));

      const { error } = await supabase
        .from("nurture_sequence_finished")
        .upsert(rows, { onConflict: "ob_lead_id,ob_campaign_id" });

      if (error) {
        errors.push(`Campaign ${campaign.id} (${campaign.name}): ${error.message}`);
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
                .then(({ error: espErr }) => {
                  if (espErr) console.error("[sync-sequence-finished] esp update failed:", espErr.message);
                });
            }).catch((e) => console.error("[sync-sequence-finished] esp lookup failed:", e));
          }
        });
      }
    } catch (e) {
      errors.push(`Campaign ${campaign.id} (${campaign.name}): ${(e as Error).message}`);
    }
  }

  return { campaignsScanned, candidatesFound, upserted, errors };
}
