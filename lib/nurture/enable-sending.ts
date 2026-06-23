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
  getCampaignSenderEmails, attachSenderEmails, resumeCampaign, inboxEsp,
} from "@/lib/outboundhero-api";
import { logActivity, logError } from "@/lib/errors";
import type { Esp } from "@/lib/nurture/esp";

const ATTACH_CHUNK = 500; // batch the attach call so a 3k-inbox pool doesn't overrun

// ── ATTACH PHASE ────────────────────────────────────────────────────────────

export interface AttachCampaignResult {
  instance: string; esp: Esp; campaignId: number; campaignName: string | null;
  poolTotal: number;        // inboxes returned for THIS campaign (all ESPs)
  matchedForEsp: number;    // pool inboxes whose provider matches this campaign's ESP
  attached: number;
  error?: string;
}
export interface AttachResult {
  clientTag: string; campaigns: AttachCampaignResult[];
  totalAttached: number; error?: string;
}

export async function attachInboxesForClient(clientTag: string): Promise<AttachResult> {
  const TAG = clientTag.toUpperCase();
  const result: AttachResult = { clientTag: TAG, campaigns: [], totalAttached: 0 };

  if (!(await getMapConfirmedAt(TAG))) { result.error = "target-campaign map not confirmed"; return result; }
  if ((await getChurnedTags()).has(TAG)) { result.error = "churned"; return result; }
  const map = await getCampaignMap(TAG);
  if (map.length === 0) { result.error = "no campaigns mapped"; return result; }

  // Read EACH mapped campaign's own tagged inbox pool, keep only the inboxes
  // whose provider matches that campaign's ESP (a campaign's pool can include
  // mixed types; never send e.g. an Outlook campaign from Google inboxes),
  // then attach in batches. Per-campaign reads matter: the pool returned for
  // the Outlook campaign differs from the Google one.
  for (const e of map) {
    const row: AttachCampaignResult = {
      instance: e.bison_instance, esp: e.esp, campaignId: e.campaign_id, campaignName: e.campaign_name,
      poolTotal: 0, matchedForEsp: 0, attached: 0,
    };
    try {
      const pool = await getCampaignSenderEmails(e.bison_instance, e.campaign_id);
      row.poolTotal = pool.length;
      // Only CONNECTED inboxes of this campaign's ESP — a disconnected inbox
      // can't send, so attaching it is noise.
      const ids = pool
        .filter((ib) => inboxEsp(ib) === e.esp && ib.status.toLowerCase() === "connected")
        .map((ib) => ib.id);
      row.matchedForEsp = ids.length;
      if (ids.length === 0) {
        row.error = pool.length === 0
          ? "no tagged inbox pool returned for this campaign"
          : `no connected ${e.esp} inboxes in this campaign's tagged pool`;
      } else {
        let attached = 0; let ok = true;
        for (let i = 0; i < ids.length; i += ATTACH_CHUNK) {
          const chunk = ids.slice(i, i + ATTACH_CHUNK);
          if (await attachSenderEmails(e.bison_instance, e.campaign_id, chunk)) attached += chunk.length;
          else { ok = false; break; }
        }
        row.attached = attached;
        result.totalAttached += attached;
        if (!ok) row.error = `attach failed after ${attached}/${ids.length}`;
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
      campaigns: result.campaigns.map((c) => ({ instance: c.instance, esp: c.esp, campaign: c.campaignName, pool: c.poolTotal, matched: c.matchedForEsp, attached: c.attached, error: c.error })),
    },
  });
  return result;
}

// ── ACTIVATE PHASE ──────────────────────────────────────────────────────────

export interface ActivateResult {
  clientTag: string;
  campaigns: Array<{ instance: string; esp: Esp; campaignId: number; campaignName: string | null; activated: boolean; error?: string }>;
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
    const row = { instance: e.bison_instance, esp: e.esp, campaignId: e.campaign_id, campaignName: e.campaign_name, activated: false as boolean, error: undefined as string | undefined };
    try {
      const r = await resumeCampaign(e.bison_instance, e.campaign_id);
      row.activated = r.ok;
      if (r.ok) result.totalActivated++;
      else row.error = `activate failed: ${r.error}`;
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
