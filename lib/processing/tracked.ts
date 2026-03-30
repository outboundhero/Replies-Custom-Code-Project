import { extractTagFromCampaignName, resolveSection } from "./tag-resolver";
import { extractCustomVars } from "./custom-vars-extractor";
import { extractRecipients } from "./recipient-extractor";
import { cleanReply } from "./reply-cleaner";
import { shouldFilter } from "./bounce-filter";
import { categorizeReply, CC_BCC_CATEGORIES, getLeadCategory } from "./lead-categorizer";
import { searchRecords, createRecord, updateRecord } from "@/lib/airtable";
import { sendToClayWebhook } from "@/lib/clay";
import { sendEsjWebhook, ESJ_CLIENT_TAGS } from "@/lib/esj-webhook";
import { shouldBlacklistDomain, blacklistDomain } from "./domain-blacklist";
import { logError, logActivity } from "@/lib/errors";
import db from "@/lib/db";
import type { EmailBisonWebhookPayload } from "@/lib/types";

async function getClientConfig(tag: string) {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM client_config WHERE client_tag = ?",
      args: [tag],
    });
    return result.rows[0] || null;
  } catch {
    // Table may not exist yet on a fresh deployment — skip client config gracefully
    return null;
  }
}

export async function processTrackedReply(payload: EmailBisonWebhookPayload) {
  const { lead, reply, campaign, sender_email } = payload.data;

  // 1. Extract tag from campaign name
  const campaignTag = extractTagFromCampaignName(campaign.name);
  if (!campaignTag) {
    await logActivity("tracked", "unroutable", {
      lead_email: lead.email,
      details: { reason: "No tag found in campaign name", campaign: campaign.name },
    });
    return;
  }

  // 2. Resolve section
  const section = await resolveSection(campaignTag);
  if (!section) {
    await logActivity("tracked", "unroutable", {
      client_tag: campaignTag,
      lead_email: lead.email,
      details: { reason: "Tag not mapped to any section", tag: campaignTag },
    });
    return;
  }

  // 3. Extract data
  const customVars = extractCustomVars(lead.custom_variables);
  const recipients = extractRecipients(reply.to, reply.cc);
  const cleanedReply = cleanReply(reply.text_body, reply.html_body);
  const clientConfig = await getClientConfig(campaignTag);

  // 3b. Bounce check + AI categorization
  const isBounce = await shouldFilter({
    from_name: reply.from_name,
    from_email: reply.from_email_address,
    text_body: reply.text_body,
    subject: reply.email_subject,
    to_address: reply.to?.[0]?.address || "",
  });
  const aiCategory = isBounce ? null : await categorizeReply(
    reply.from_email_address,
    recipients.ccEmails || "",
    reply.email_subject,
    cleanedReply,
  );
  const includeClientConfig = aiCategory !== null && CC_BCC_CATEGORIES.includes(aiCategory as typeof CC_BCC_CATEGORIES[number]);

  // 4. Build Airtable field values
  const baseFields: Record<string, unknown> = {
    "Lead Email": reply.from_email_address,
    "Lead Name": `${lead.first_name} ${lead.last_name}`.trim(),
    "Lead ID": lead.id,
    "Company Name": lead.company,
    "Campaign Name": campaign.name,
    "Campaign ID": campaign.id,
    "Sender Email": sender_email.email,
    "Sender ID": sender_email.id,
    "Sender Name": sender_email.name,
    "Email Subject": reply.email_subject,
    "Reply we got": cleanedReply,
    "Reply ID": reply.id,
    "From Name": reply.from_name,
    "From Email": reply.from_email_address,
    "To Email": recipients.toEmails,
    "To Name": recipients.toNames,
    "Prospect CC email": recipients.ccEmails,
    "Prospect CC name": recipients.ccNames,
    "Phone": customVars.phone,
    "Person Linkedin URL": customVars.linkedin,
    "Reply Time": recipients.replyTime,
    "Client Tag": campaignTag,
    "First Name": lead.first_name,
    "Last Name": lead.last_name,
    "Address": customVars.address,
    "City": customVars.city,
    "State": customVars.state,
    "Google Maps URL": customVars.google_maps_url,
    "Lead Category": getLeadCategory(aiCategory),
    ...(aiCategory && { "AI Categorized Lead Category": aiCategory }),
    // Client config fields — only for actionable AI categories
    ...(includeClientConfig && clientConfig?.cc_name_1 && { "CC name 1": clientConfig.cc_name_1 }),
    ...(includeClientConfig && clientConfig?.cc_email_1 && { "CC email 1": clientConfig.cc_email_1 }),
    ...(includeClientConfig && clientConfig?.cc_name_2 && { "CC name 2": clientConfig.cc_name_2 }),
    ...(includeClientConfig && clientConfig?.cc_email_2 && { "CC email 2": clientConfig.cc_email_2 }),
    ...(includeClientConfig && clientConfig?.cc_name_3 && { "CC name 3": clientConfig.cc_name_3 }),
    ...(includeClientConfig && clientConfig?.cc_email_3 && { "CC email 3": clientConfig.cc_email_3 }),
    ...(includeClientConfig && clientConfig?.cc_name_4 && { "CC name 4": clientConfig.cc_name_4 }),
    ...(includeClientConfig && clientConfig?.cc_email_4 && { "CC email 4": clientConfig.cc_email_4 }),
    ...(includeClientConfig && clientConfig?.cc_name_5 && { "CC name 5": clientConfig.cc_name_5 }),
    ...(includeClientConfig && clientConfig?.cc_email_5 && { "CC email 5": clientConfig.cc_email_5 }),
    ...(includeClientConfig && clientConfig?.cc_name_6 && { "CC name 6": clientConfig.cc_name_6 }),
    ...(includeClientConfig && clientConfig?.cc_email_6 && { "CC email 6": clientConfig.cc_email_6 }),
    ...(includeClientConfig && clientConfig?.bcc_name_1 && { "BCC name 1": clientConfig.bcc_name_1 }),
    ...(includeClientConfig && clientConfig?.bcc_email_1 && { "BCC email 1": clientConfig.bcc_email_1 }),
    ...(includeClientConfig && clientConfig?.bcc_name_2 && { "BCC name 2": clientConfig.bcc_name_2 }),
    ...(includeClientConfig && clientConfig?.bcc_email_2 && { "BCC email 2": clientConfig.bcc_email_2 }),
    ...(includeClientConfig && clientConfig?.reply_template && { "Our reply": clientConfig.reply_template }),
  };

  // 5. Search for existing record
  let recordId: string | undefined;
  let action: string;

  try {
    const existingRecords = await searchRecords(
      section.airtable_base_id,
      section.airtable_table_id,
      `AND({Lead ID} = "${lead.id}", {Campaign Name} = "${campaign.name.replace(/"/g, '\\"')}")`
    );

    if (existingRecords.length > 0) {
      // UPDATE existing
      recordId = existingRecords[0].id;
      await updateRecord(section.airtable_base_id, section.airtable_table_id, recordId, {
        ...baseFields,
        "Reply Status": "Pending again",
      });
      action = "updated";
    } else {
      // CREATE new
      recordId = await createRecord(section.airtable_base_id, section.airtable_table_id, {
        ...baseFields,
        "Reply Status": "Pending",
      });
      action = "created";
    }
  } catch (error) {
    await logError("tracked", "airtable", (error as Error).message, {
      tag: campaignTag,
      section: section.name,
      lead_email: lead.email,
    });
    throw error;
  }

  // 6. Send to master Clay table (all sections) — only for qualified replies
  const replyBodyLower = (reply.text_body || "").toLowerCase();
  const fromEmailLower = (reply.from_email_address || "").toLowerCase();
  const senderEmailLower = (sender_email.email || "").toLowerCase();
  const bouncePattern = /could not be delivered|DMARC|Error message|This is the mail system|automated message|I wasn't able to|Failed to deliver|aggregate report from|Permanent fatal|Fatal Error|Permanent error|Report domain:|couldn't be delivered|delivery has failed|temporary problem|not delivered|please try again|Empty Response|Error Type|undeliverable|address not found|to postmaster|message blocked|Address not reachable|Address not found|Delivery Status Notification|message bounced/i;
  const fromEmailBlockPattern = /(@inbox|inbox\.com|inboxes\.com|@inboxes|dmarc|daemon|maildeliverysystem|postmaster)/;
  const senderEmailBlockPattern = /inbox\.com|@inbox|inboxes\.com|@inboxes/i;
  const qualifiedCategories = ["interested", "meeting request", "follow up at a later date"];

  const shouldSendToMasterClay =
    !!reply.text_body &&
    !replyBodyLower.includes("stick-enjoy") &&
    !replyBodyLower.includes("steep-swung") &&
    !bouncePattern.test(reply.text_body) &&
    !fromEmailBlockPattern.test(fromEmailLower) &&
    !senderEmailBlockPattern.test(senderEmailLower) &&
    !!aiCategory &&
    qualifiedCategories.includes(aiCategory.toLowerCase());

  if (shouldSendToMasterClay) {
  try {
    const senderNameParts2 = (sender_email.name || "").split(" ");
    await sendToClayWebhook(
      "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-50ef291a-c367-42cd-96ef-60e8eb2fd970",
      {
        record_id: recordId,
        reply_we_got: reply.text_body,
        reply_subject: reply.email_subject,
        from_email: reply.from_email_address,
        sender_email: sender_email.email,
        client_tag: campaignTag,
        first_name: lead.first_name,
        last_name: lead.last_name,
        company: lead.company,
        company_phone: customVars.phone,
        linkedin: customVars.linkedin,
        cc_names: recipients.ccNames,
        cc_emails: recipients.ccEmails,
        city: customVars.city,
        state: customVars.state,
        google_maps_url: customVars.google_maps_url,
        address: customVars.address,
        full_sender_name: sender_email.name,
        sender_first_name: senderNameParts2[0] || "",
        "Meeting-Ready Lead": "No",
        "from full name": reply.from_name,
        lead_email: reply.from_email_address,
        lead_name: `${lead.first_name} ${lead.last_name}`.trim(),
        lead_id: lead.id,
        campaign_name: campaign.name,
        campaign_id: campaign.id,
        sender_id: sender_email.id,
        sender_name: sender_email.name,
        reply_id: reply.id,
        to_email: recipients.toEmails,
        to_name: recipients.toNames,
        reply_time: recipients.replyTime,
        lead_category: "Open Response",
        reply_status: action === "created" ? "Pending" : "Pending again",
        reply_cleaned: cleanedReply,
        ai_lead_category: aiCategory,
        airtable_base_id: section.airtable_base_id,
        section_name: section.name,
      }
    );
  } catch (error) {
    await logError("tracked", "master-clay", (error as Error).message, {
      tag: campaignTag,
      record_id: recordId,
    });
  }
  }

  // 6b. Extra Clay webhook for ESJ/JPSD/JPWPB
  if (ESJ_CLIENT_TAGS.includes(campaignTag)) {
    try {
      await sendEsjWebhook({
        record_id: recordId,
        reply_we_got: reply.text_body,
        reply_subject: reply.email_subject,
        reply_cleaned: cleanedReply,
        from_email: reply.from_email_address,
        "from full name": reply.from_name,
        lead_id: lead.id,
        first_name: lead.first_name,
        last_name: lead.last_name,
        lead_email: reply.from_email_address,
        company: lead.company,
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        client_tag: campaignTag,
        reply_id: reply.id,
        reply_time: recipients.replyTime,
        ai_lead_category: aiCategory,
      });
    } catch (error) {
      await logError("tracked", "esj-clay", (error as Error).message, {
        campaign_tag: campaignTag,
        lead_email: reply.from_email_address,
      });
    }
  }

  // 6c. Domain blacklisting
  const blacklistMatch = shouldBlacklistDomain(reply.email_subject, reply.text_body);
  if (blacklistMatch) {
    await blacklistDomain(reply.from_email_address, blacklistMatch, "tracked", {
      client_tag: campaignTag,
      section_name: section.name,
    });
  }

  // 7. Log activity
  await logActivity("tracked", action, {
    client_tag: campaignTag,
    section_name: section.name,
    lead_email: reply.from_email_address,
    details: { airtable_base_id: section.airtable_base_id, record_id: recordId, ai_category: aiCategory },
  });
}
