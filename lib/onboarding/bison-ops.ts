/** The campaign builder's Email Bison calls, wired to the real API (lib/outboundhero-api.ts). */
import {
  createCampaignOnce, updateCampaignOnce, getCampaignRaw, addSequenceSteps, getSequenceSteps,
  createScheduleOnce, getCampaignSchedule, setCampaignTags, getCampaignWithTags,
} from "@/lib/outboundhero-api";
import type { BisonOps } from "@/lib/onboarding/build-campaigns";

export const realBisonOps: BisonOps = {
  createCampaign: (instance, name) => createCampaignOnce(instance, name),
  updateCampaign: (instance, id, fields) => updateCampaignOnce(instance, id, fields),
  getCampaign: (instance, id) => getCampaignRaw(instance, id),
  addSteps: (instance, id, title, steps) => addSequenceSteps(instance, id, title, steps as unknown as Record<string, unknown>[]),
  async getSteps(instance, id) {
    const raw = (await getSequenceSteps(instance, id)) as { sequence_steps?: Record<string, unknown>[] } | null;
    return raw && Array.isArray(raw.sequence_steps) ? raw.sequence_steps : null;
  },
  createSchedule: (instance, id, schedule) => createScheduleOnce(instance, id, schedule as unknown as Record<string, unknown>),
  getSchedule: (instance, id) => getCampaignSchedule(instance, id),
  attachTags: (instance, tagIds, campaignIds) => setCampaignTags(instance, "attach", tagIds, campaignIds),
  async getTags(instance, id) {
    const c = await getCampaignWithTags(instance, id);
    return c ? c.tags : null;
  },
};
