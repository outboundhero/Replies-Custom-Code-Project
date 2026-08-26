/**
 * OutboundHero (OH) new-reply push.
 *
 * OH leads used to go to Close.com CRM (see lib/close-crm.ts). That is retired —
 * OH now flows to the SAME Clay table DM4PM uses, distinguished by the
 * "sub-client" field ("OH"). Fires at INGEST on a NEW reply with an actionable
 * AI category, mirroring the DM4PM push (lib/dm4pm-webhook.ts). Clay only — no
 * Slack notifier (DM4PM's Slack is its own channel).
 */
import { sendToClayWebhook } from "@/lib/clay";
import { DM4PM_CLAY_WEBHOOK, dm4pmShouldPush } from "@/lib/dm4pm-webhook";

// OH shares DM4PM's "actionable AI category" gate (skip OOO / wrong-person /
// do-not-contact / automated), so the two clients push on the same criteria.
export const ohShouldPush = dm4pmShouldPush;

export interface OhLead {
  email: string;
  leadName: string;
  company?: string | null;
  website?: string | null;
  linkedin?: string | null;
  leadResponse?: string | null;
}

/** Push an OH lead to the shared Clay table with sub-client "OH". Throws on
 *  webhook failure so the caller can log it (fire-and-forget, never blocks
 *  ingest). */
export async function sendOhWebhook(lead: OhLead): Promise<void> {
  await sendToClayWebhook(DM4PM_CLAY_WEBHOOK, {
    "E-mail": lead.email,
    "sub-client": "OH",
    "Lead Response": lead.leadResponse ?? "",
    "Company Name": lead.company ?? "",
    "Contact Name": lead.leadName,
    "Website": lead.website ?? "",
    "LinkedIn URL": lead.linkedin ?? "",
  });
}
