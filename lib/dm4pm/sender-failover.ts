/**
 * DM4PM sender failover selection (§20). When the active sending inbox is
 * disconnected/deleted, the subsequence must not stall — pick a healthy
 * replacement from the SAME DM4PM campaign's inbox pool and hand it back to the
 * cron, which continues in a new thread (a reassigned sender can't continue the
 * original thread — confirmed against the Bison API).
 *
 * Health signal (confirmed): sender `status === "Connected"`. `getSenderEmail`
 * also yields the display `name` for {SENDER_NAME}, which the campaign
 * sender-emails LIST does not carry.
 */
import { getSenderEmail, getCampaignSenderEmails } from "@/lib/outboundhero-api";

const isHealthy = (status: string): boolean => status.trim().toLowerCase() === "connected";

/**
 * Any DM4PM cold campaign on `outboundhero` — used ONLY to fetch the DM4PM
 * client-tag inbox pool for untracked replies (campaign_id 0/null). The
 * sender-emails endpoint returns the tag pool, not that one campaign's senders,
 * so which DM4PM campaign we pass doesn't matter.
 */
const DEFAULT_DM4PM_CAMPAIGN = 663;

export interface SenderPick { id: number; email: string; name: string }

/** Health + display name for one sender inbox. Null if it can't be fetched. */
export async function getSenderHealth(
  instanceKey: string,
  senderEmailId: number,
): Promise<{ healthy: boolean; name: string; email: string } | null> {
  const d = await getSenderEmail(instanceKey, senderEmailId);
  if (!d) return null;
  return { healthy: isHealthy(d.status), name: d.name, email: d.email };
}

/**
 * Pick a healthy replacement sender from the DM4PM campaign pool, excluding the
 * dead one. Resolves the pick's display name via the single-sender endpoint
 * (the pool list omits it). Returns null when no healthy sender is available.
 */
export async function pickHealthySender(
  instanceKey: string,
  campaignId: number | null,
  excludeId: number | null,
): Promise<SenderPick | null> {
  const poolCampaign = campaignId && campaignId > 0 ? campaignId : DEFAULT_DM4PM_CAMPAIGN;
  const pool = await getCampaignSenderEmails(instanceKey, poolCampaign);
  const healthy = pool.filter((s) => isHealthy(s.status) && s.id !== excludeId);
  if (!healthy.length) return null;
  const chosen = healthy[0];
  const detail = await getSenderEmail(instanceKey, chosen.id);
  return { id: chosen.id, email: detail?.email || chosen.email, name: detail?.name || "" };
}

/** First name for {SENDER_NAME} — first whitespace token of the account name. */
export function senderFirstName(name: string): string {
  return String(name || "").trim().split(/\s+/)[0] || "";
}
