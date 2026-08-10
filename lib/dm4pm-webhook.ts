/**
 * DM4PM new-reply push.
 *
 * Replaces the Airtable "run a script" automation for DM4PM: on a NEW reply
 * (ingest only — not updates) with an ACTIONABLE AI category, send the lead to
 * DM4PM's Clay webhook and its Slack notifier (a Google Apps Script). Wired into
 * the ingest pipeline (lib/processing/tracked.ts / untracked.ts), mirroring the
 * ESJ webhook pattern (lib/esj-webhook.ts).
 */
import { sendToClayWebhook } from "@/lib/clay";

const DM4PM_CLAY_WEBHOOK =
  "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-041ec6d2-a3d1-43b2-859d-b9c04672185d";
// Google Apps Script that posts the lead to DM4PM's Slack.
const DM4PM_SLACK_WEBHOOK =
  "https://script.google.com/macros/s/AKfycbw3o4gXrVPjL7q60rh6UrvTd1sPO2YVDRddVMXVuh8Lq9KM8-XA7ewY_nvgPRZU46in5Q/exec";

// AI categories that are NOT actionable → skip the DM4PM push. Includes both the
// old Airtable names and the ReplyRouter equivalents (e.g. "Automated Reply" →
// "Automated Error Message" / "Automated Catch-All Message").
const DM4PM_SKIP_AI = new Set([
  "wrong person (change of target)",
  "out of office",
  "do not contact",
  "automated reply",
  "automated error message",
  "automated catch-all message",
]);

/** True when a DM4PM reply's AI category is actionable enough to push. */
export function dm4pmShouldPush(aiCategory: string | null | undefined): boolean {
  const c = (aiCategory || "").trim().toLowerCase();
  return !!c && !DM4PM_SKIP_AI.has(c);
}

export interface Dm4pmLead {
  email: string;
  leadName: string;
  company?: string | null;
  website?: string | null;
  linkedin?: string | null;
  leadResponse?: string | null;
  campaignName?: string | null;
  replyId: number;
}

/** Push a DM4PM lead to Clay + its Slack notifier. Throws on webhook failure so
 *  the caller can log it (fire-and-forget, never blocks ingest). */
export async function sendDm4pmWebhooks(lead: Dm4pmLead): Promise<void> {
  // 1. Clay (DM4PM sub-client table).
  await sendToClayWebhook(DM4PM_CLAY_WEBHOOK, {
    "E-mail": lead.email,
    "sub-client": "DM4PM",
    "Lead Response": lead.leadResponse ?? "",
    "Company Name": lead.company ?? "",
    "Contact Name": lead.leadName,
    "Website": lead.website ?? "",
    "LinkedIn URL": lead.linkedin ?? "",
  });

  // 2. Slack notifier. `airtable_id` now carries our ReplyRouter reply id, and
  //    the source is ReplyRouter (Airtable is unplugged).
  const res = await fetch(DM4PM_SLACK_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      to_email: lead.email,
      campaign_name: lead.campaignName ?? "",
      airtable_id: lead.replyId,
      email_system_used: "ReplyRouter",
    }),
  });
  if (!res.ok) throw new Error(`DM4PM Slack webhook failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}
