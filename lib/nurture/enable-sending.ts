/**
 * Enable sending for a client's confirmed nurture map. Two phases, run in this
 * order by the UI: ATTACH inboxes → (route ready leads) → ACTIVATE campaigns.
 *
 * Inbox model: Bison's GET /api/campaigns/{id}/sender-emails returns the
 * client(tag)-scoped inbox POOL (every inbox carrying the client tag — all
 * ESPs mixed), NOT the inboxes attached to that one campaign. So to attach
 * "all the sender inboxes with the client tag" correctly, we read that pool
 * once per instance and SPLIT it by inbox ESP (Outlook inboxes → the Outlook
 * nurture campaign, Google → Google, smtp → SEGs). Attaching the whole mixed
 * pool to every campaign would send e.g. the Outlook campaign from Google
 * inboxes and defeat the per-ESP segmentation, so we attach only the matching
 * subset to each mapped campaign.
 */
import { getCampaignMap, getMapConfirmedAt } from "@/lib/nurture/campaign-map";
import { getChurnedTags } from "@/lib/churn";
import {
  getCampaignSenderEmails, attachSenderEmails, resumeCampaign,
} from "@/lib/outboundhero-api";
import { logActivity, logError } from "@/lib/errors";
import type { Esp } from "@/lib/nurture/esp";

const ATTACH_CHUNK = 500; // batch the attach call so a 3k-inbox pool doesn't overrun

// ── ATTACH PHASE ────────────────────────────────────────────────────────────

export interface AttachCampaignResult {
  instance: string; esp: Esp; campaignId: number; campaignName: string | null;
  poolTotal: number;        // inboxes in the client's tagged pool for this campaign
  connected: number;        // connected ones (candidates to attach)
  attached: number;         // newly attached
  alreadyPresent: number;   // were already on the campaign (nothing added)
  error?: string;
}
export interface AttachResult {
  clientTag: string; campaigns: AttachCampaignResult[];
  totalAttached: number; totalAlreadyPresent: number; error?: string;
}

export async function attachInboxesForClient(clientTag: string): Promise<AttachResult> {
  const TAG = clientTag.toUpperCase();
  const result: AttachResult = { clientTag: TAG, campaigns: [], totalAttached: 0, totalAlreadyPresent: 0 };

  if (!(await getMapConfirmedAt(TAG))) { result.error = "target-campaign map not confirmed"; return result; }
  if ((await getChurnedTags()).has(TAG)) { result.error = "churned"; return result; }
  const map = await getCampaignMap(TAG);
  if (map.length === 0) { result.error = "no campaigns mapped"; return result; }

  // Attach ALL of the client's tagged inboxes to each mapped campaign. ESP is
  // a LEAD-routing concept (each lead goes to its provider's campaign) — it is
  // NOT a filter on sender inboxes, so we never split the inbox pool by ESP.
  // We only drop disconnected inboxes (they can't send).
  for (const e of map) {
    const row: AttachCampaignResult = {
      instance: e.bison_instance, esp: e.esp, campaignId: e.campaign_id, campaignName: e.campaign_name,
      poolTotal: 0, connected: 0, attached: 0, alreadyPresent: 0,
    };
    try {
      const pool = await getCampaignSenderEmails(e.bison_instance, e.campaign_id);
      row.poolTotal = pool.length;
      const ids = pool
        .filter((ib) => ib.status.toLowerCase() === "connected")
        .map((ib) => ib.id);
      row.connected = ids.length;
      if (ids.length === 0) {
        row.error = pool.length === 0
          ? "no tagged inbox pool returned for this campaign"
          : "no connected inboxes in this campaign's tagged pool";
      } else {
        let attached = 0, alreadyPresent = 0; let failMsg: string | undefined;
        for (let i = 0; i < ids.length; i += ATTACH_CHUNK) {
          const chunk = ids.slice(i, i + ATTACH_CHUNK);
          const r = await attachSenderEmails(e.bison_instance, e.campaign_id, chunk);
          if (r.added) attached += chunk.length;
          else if (r.alreadyPresent) alreadyPresent += chunk.length;
          else { failMsg = r.message || "attach failed"; break; }
        }
        row.attached = attached;
        row.alreadyPresent = alreadyPresent;
        result.totalAttached += attached;
        result.totalAlreadyPresent += alreadyPresent;
        if (failMsg) row.error = `attach failed after ${attached}/${ids.length}: ${failMsg}`;
      }
    } catch (err) {
      row.error = (err as Error).message;
      await logError("nurture-enable-sending", `${TAG}/${e.bison_instance}/${e.esp}/attach`, row.error);
    }
    result.campaigns.push(row);
  }

  await logActivity("nurture-enable-sending", "inboxes-attached", {
    client_tag: TAG,
    details: {
      total_attached: result.totalAttached,
      total_already_present: result.totalAlreadyPresent,
      campaigns: result.campaigns.map((c) => ({ instance: c.instance, esp: c.esp, campaign: c.campaignName, pool: c.poolTotal, connected: c.connected, attached: c.attached, already_present: c.alreadyPresent, error: c.error })),
    },
  });
  return result;
}

// ── ACTIVATE PHASE ──────────────────────────────────────────────────────────

export interface ActivateResult {
  clientTag: string;
  campaigns: Array<{ instance: string; esp: Esp; campaignId: number; campaignName: string | null; activated: boolean; alreadyActive: boolean; error?: string }>;
  totalActivated: number; error?: string;
}

export async function activateMappedCampaigns(clientTag: string): Promise<ActivateResult> {
  const TAG = clientTag.toUpperCase();
  const result: ActivateResult = { clientTag: TAG, campaigns: [], totalActivated: 0 };

  if (!(await getMapConfirmedAt(TAG))) { result.error = "target-campaign map not confirmed"; return result; }
  if ((await getChurnedTags()).has(TAG)) { result.error = "churned"; return result; }
  const map = await getCampaignMap(TAG);
  if (map.length === 0) { result.error = "no campaigns mapped"; return result; }

  for (const e of map) {
    const row = { instance: e.bison_instance, esp: e.esp, campaignId: e.campaign_id, campaignName: e.campaign_name, activated: false as boolean, alreadyActive: false as boolean, error: undefined as string | undefined };
    try {
      const r = await resumeCampaign(e.bison_instance, e.campaign_id);
      if (r.ok) {
        row.activated = true;
        result.totalActivated++;
      } else if (/not paused|already (active|running|launched)|only paused or draft/i.test(`${r.error ?? ""} ${JSON.stringify(r.raw ?? "")}`)) {
        // Bison 400 "This campaign is not paused…" = it's already live. Not an
        // error — count it as active.
        row.activated = true;
        row.alreadyActive = true;
        result.totalActivated++;
      } else {
        row.error = `activate failed: ${r.error}`;
      }
    } catch (err) {
      row.error = (err as Error).message;
      await logError("nurture-enable-sending", `${TAG}/${e.bison_instance}/${e.esp}/activate`, row.error);
    }
    result.campaigns.push(row);
  }

  await logActivity("nurture-enable-sending", "campaigns-activated", {
    client_tag: TAG, details: { total_activated: result.totalActivated, campaigns: result.campaigns },
  });
  return result;
}
