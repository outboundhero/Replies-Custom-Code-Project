import { extractTagFromCampaignName, resolveSection } from "./tag-resolver";
import { extractCustomVars } from "./custom-vars-extractor";
import { extractRecipients } from "./recipient-extractor";
import { cleanReply } from "./reply-cleaner";
import { searchRecords, createRecord, updateRecord } from "@/lib/airtable";
import { sendToClayWebhook } from "@/lib/clay";
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

  // 4. Build Airtable field values
  const baseFields: Record<string, unknown> = {
    "Lead Email": lead.email,
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
    "Lead Category": "Open Response",
    // Client config fields
    ...(clientConfig?.cc_name_1 && { "CC Name 1": clientConfig.cc_name_1 }),
    ...(clientConfig?.cc_email_1 && { "CC Email 1": clientConfig.cc_email_1 }),
    ...(clientConfig?.cc_name_2 && { "CC Name 2": clientConfig.cc_name_2 }),
    ...(clientConfig?.cc_email_2 && { "CC Email 2": clientConfig.cc_email_2 }),
    ...(clientConfig?.cc_name_3 && { "CC Name 3": clientConfig.cc_name_3 }),
    ...(clientConfig?.cc_email_3 && { "CC Email 3": clientConfig.cc_email_3 }),
    ...(clientConfig?.cc_name_4 && { "CC Name 4": clientConfig.cc_name_4 }),
    ...(clientConfig?.cc_email_4 && { "CC Email 4": clientConfig.cc_email_4 }),
    ...(clientConfig?.bcc_name_1 && { "BCC Name 1": clientConfig.bcc_name_1 }),
    ...(clientConfig?.bcc_email_1 && { "BCC Email 1": clientConfig.bcc_email_1 }),
    ...(clientConfig?.bcc_name_2 && { "BCC Name 2": clientConfig.bcc_name_2 }),
    ...(clientConfig?.bcc_email_2 && { "BCC Email 2": clientConfig.bcc_email_2 }),
    ...(clientConfig?.reply_template && { "Our Reply": clientConfig.reply_template }),
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

  // 6. Send to Clay
  if (section.clay_webhook_url_tracked) {
    try {
      const senderNameParts = (sender_email.name || "").split(" ");
      const clayData = {
        // Existing keys (do not rename — mapped in Clay)
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
        sender_first_name: senderNameParts[0] || "",
        "Meeting-Ready Lead": "No",
        "from full name": reply.from_name,
        // Additional fields
        lead_email: lead.email,
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
      };
      await sendToClayWebhook(section.clay_webhook_url_tracked, clayData);
    } catch (error) {
      await logError("tracked", "clay", (error as Error).message, {
        tag: campaignTag,
        section: section.name,
        record_id: recordId,
        _clay_retry_data: {
          webhook_url: section.clay_webhook_url_tracked,
          data: {
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
            sender_first_name: (sender_email.name || "").split(" ")[0] || "",
            "Meeting-Ready Lead": "No",
            "from full name": reply.from_name,
            lead_email: lead.email,
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
          },
        },
      });
      // Clay failure does NOT block — already wrote to Airtable
    }
  }

  // 7. Log activity
  await logActivity("tracked", action, {
    client_tag: campaignTag,
    section_name: section.name,
    lead_email: lead.email,
    details: { airtable_base_id: section.airtable_base_id, record_id: recordId },
  });
}
