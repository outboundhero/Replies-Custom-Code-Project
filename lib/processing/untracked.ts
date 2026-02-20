import { shouldFilter } from "./bounce-filter";
import { detectCompanyCode } from "./company-code-resolver";
import { resolveRedirectLink } from "./redirect-resolver";
import { extractRecipients } from "./recipient-extractor";
import { cleanReply } from "./reply-cleaner";
import { searchRecords, createRecord, updateRecord } from "@/lib/airtable";
import { sendToClayWebhook } from "@/lib/clay";
import { logError, logActivity } from "@/lib/errors";
import db from "@/lib/db";
import type { EmailBisonUntrackedPayload, UntrackedConfig } from "@/lib/types";

async function getUntrackedConfig(): Promise<UntrackedConfig> {
  const result = await db.execute("SELECT * FROM untracked_config WHERE id = 1");
  const row = result.rows[0];
  return {
    id: row.id as number,
    airtable_base_id: row.airtable_base_id as string,
    airtable_table_id: row.airtable_table_id as string,
    meeting_ready_table_id: row.meeting_ready_table_id as string,
    clay_webhook_url: row.clay_webhook_url as string | null,
  };
}

export async function processUntrackedReply(payload: EmailBisonUntrackedPayload) {
  const { reply, sender_email } = payload.data;

  // 1. Bounce filtering
  const toAddress = reply.to?.[0]?.address || "";
  const filtered = await shouldFilter({
    from_name: reply.from_name,
    from_email: reply.from_email_address,
    text_body: reply.text_body,
    subject: reply.email_subject,
    to_address: toAddress,
  });

  if (filtered) {
    await logActivity("untracked", "filtered", {
      lead_email: reply.from_email_address,
      details: { from_name: reply.from_name, subject: reply.email_subject },
    });
    return;
  }

  // 2. Resolve redirect link from the CLIENT's sending domain (sender_email),
  //    NOT the prospect's from_email_address. e.g. tdawson@elitecustodialcare.co
  //    redirects to https://absolutefsinc.com/ which identifies the client.
  const senderDomain = sender_email.email.split("@")[1] || "";
  const redirectLink = await resolveRedirectLink(senderDomain);
  const { code: companyCode } = await detectCompanyCode(
    reply.from_email_address,
    reply.text_body,
    redirectLink
  );

  // 3. Get untracked config (single section)
  const config = await getUntrackedConfig();

  // 4. Extract name
  const nameParts = (reply.from_name || "").trim().split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ") || "";

  // 5. Extract recipients + clean reply
  const recipients = extractRecipients(reply.to, reply.cc);
  const cleanedReply = cleanReply(reply.text_body, reply.html_body);

  // Fetch client config by company code (non-fatal — table may not exist on fresh deploy)
  let clientConfig = null;
  try {
    const clientConfigResult = await db.execute({
      sql: "SELECT * FROM client_config WHERE client_tag = ?",
      args: [companyCode],
    });
    clientConfig = clientConfigResult.rows[0] || null;
  } catch {
    // Skip client config gracefully if table is missing
  }

  // 6. Build Airtable fields
  const baseFields: Record<string, unknown> = {
    "Lead Email": reply.from_email_address,
    "Lead Name": reply.from_name,
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
    "Reply Time": recipients.replyTime,
    "Client Tag": companyCode,
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

  // 7. Search for existing record
  let recordId: string | undefined;
  let action: string;

  try {
    const escapedEmail = reply.from_email_address.replace(/"/g, '\\"');
    const escapedTag = companyCode.replace(/"/g, '\\"');
    const existingRecords = await searchRecords(
      config.airtable_base_id,
      config.airtable_table_id,
      `AND({Lead Email} = "${escapedEmail}", {Client Tag} = "${escapedTag}")`
    );

    if (existingRecords.length > 0) {
      recordId = existingRecords[0].id;
      await updateRecord(config.airtable_base_id, config.airtable_table_id, recordId, {
        ...baseFields,
        "Reply Status": "Pending again",
      });
      action = "updated";
    } else {
      recordId = await createRecord(config.airtable_base_id, config.airtable_table_id, {
        ...baseFields,
        "Reply Status": "Pending",
      });
      action = "created";
    }
  } catch (error) {
    await logError("untracked", "airtable", (error as Error).message, {
      company_code: companyCode,
      lead_email: reply.from_email_address,
    });
    throw error;
  }

  // 8. Send to Clay
  if (config.clay_webhook_url) {
    try {
      const senderNameParts = (sender_email.name || "").split(" ");
      const clayData = {
        // Existing keys (do not rename — mapped in Clay)
        record_id: recordId,
        reply_we_got: reply.text_body,
        reply_subject: reply.email_subject,
        from_email: reply.from_email_address,
        sender_email: sender_email.email,
        client_tag: companyCode,
        first_name: firstName,
        last_name: lastName,
        cc_names: recipients.ccNames,
        cc_emails: recipients.ccEmails,
        full_sender_name: sender_email.name,
        sender_first_name: senderNameParts[0] || "",
        "Meeting-Ready Lead": "No",
        "from full name": reply.from_name,
        // Additional fields
        lead_email: reply.from_email_address,
        lead_name: reply.from_name,
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
      await sendToClayWebhook(config.clay_webhook_url, clayData);
    } catch (error) {
      await logError("untracked", "clay", (error as Error).message, {
        company_code: companyCode,
        record_id: recordId,
        _clay_retry_data: {
          webhook_url: config.clay_webhook_url,
          data: {
            record_id: recordId,
            reply_we_got: reply.text_body,
            reply_subject: reply.email_subject,
            from_email: reply.from_email_address,
            sender_email: sender_email.email,
            client_tag: companyCode,
            first_name: firstName,
            last_name: lastName,
            cc_names: recipients.ccNames,
            cc_emails: recipients.ccEmails,
            full_sender_name: sender_email.name,
            sender_first_name: (sender_email.name || "").split(" ")[0] || "",
            "Meeting-Ready Lead": "No",
            "from full name": reply.from_name,
            lead_email: reply.from_email_address,
            lead_name: reply.from_name,
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
    }
  }

  // 9. Log activity
  await logActivity("untracked", action, {
    client_tag: companyCode,
    section_name: "Untracked",
    lead_email: reply.from_email_address,
    details: { airtable_base_id: config.airtable_base_id, record_id: recordId },
  });
}
