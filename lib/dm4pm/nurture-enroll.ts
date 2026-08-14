/**
 * DM4PM subsequence → Nurture Queue hand-off (§21 soft-no, §23 step-7 complete).
 *
 * Reuses the existing nurture routing rather than a new destination: DM4PM
 * already has 6 mapped nurture campaigns (nurture_campaign_map). Resolve the
 * lane (b2b/b2c by personal-vs-business email) + ESP, look up DM4PM's campaign
 * for that instance+ESP, and attach the lead. Best-effort — a failure here must
 * never block the subsequence's stop/complete transition.
 */
import { getCampaignMap, pickFromMap } from "@/lib/nurture/campaign-map";
import { targetInstanceForLead } from "@/lib/nurture/group-routing";
import { detectEsp } from "@/lib/nurture/esp";
import { findLeadByEmail, attachLeadsToCampaign } from "@/lib/outboundhero-api";
import { logActivity, logError } from "@/lib/errors";

export interface NurtureEnrollResult {
  ok: boolean;
  reason?: string;
  instance?: string;
  esp?: string;
  campaignId?: number;
}

/**
 * Enroll a DM4PM lead (by email) into its correct nurture campaign. Returns a
 * result object; never throws. The b2b path (business email → outboundhero,
 * where DM4PM leads already live) resolves fully; a b2c lead not yet placed on
 * the b2c instance is reported as `lead not found` for manual handling.
 */
export async function enrollDm4pmInNurture(email: string): Promise<NurtureEnrollResult> {
  try {
    if (!email?.trim()) return { ok: false, reason: "no email" };
    const target = await targetInstanceForLead("DM4PM", email);
    if (!target) return { ok: false, reason: "DM4PM has no group mapping" };
    const esp = detectEsp(email);
    const entry = pickFromMap(await getCampaignMap("DM4PM"), target.instance, esp);
    if (!entry) return { ok: false, reason: `no nurture campaign mapped for ${target.instance}/${esp}` };

    const lead = await findLeadByEmail(target.instance, email);
    if (!lead) return { ok: false, reason: `lead not found on ${target.instance}`, instance: target.instance, esp, campaignId: entry.campaign_id };

    const res = await attachLeadsToCampaign(target.instance, entry.campaign_id, [lead.id]);
    if (!res.ok) {
      await logError("dm4pm-subsequence", "nurture-enroll", res.error || "attach failed", { lead_email: email, instance: target.instance, esp, campaign_id: entry.campaign_id });
      return { ok: false, reason: res.error || "attach failed", instance: target.instance, esp, campaignId: entry.campaign_id };
    }
    await logActivity("dm4pm-subsequence", "nurture-enrolled", {
      lead_email: email,
      details: { instance: target.instance, esp, campaign_id: entry.campaign_id },
    });
    return { ok: true, instance: target.instance, esp, campaignId: entry.campaign_id };
  } catch (e) {
    await logError("dm4pm-subsequence", "nurture-enroll", (e as Error).message, { lead_email: email }).catch(() => {});
    return { ok: false, reason: (e as Error).message };
  }
}
