// ── EmailBison Webhook Payload Types ──
// EmailBison sends { event, data } directly — no body wrapper

export interface EmailBisonWebhookPayload {
  data: {
    lead: {
      id: number;
      email: string;
      first_name: string;
      last_name: string;
      company: string;
      custom_variables: Record<string, { name: string; value: string }>;
    };
    reply: {
      id: number;
      email_subject: string;
      text_body: string;
      html_body: string;
      from_name: string;
      from_email_address: string;
      to: Array<{ name: string; address: string }> | null;
      cc: Array<{ name: string; address: string }> | null;
    };
    campaign: {
      id: number;
      name: string;
    };
    sender_email: {
      id: number;
      email: string;
      name: string;
    };
  };
}

// Untracked may not have lead/campaign fields
export interface EmailBisonUntrackedPayload {
  data: {
    reply: {
      id: number;
      email_subject: string;
      text_body: string;
      html_body: string;
      from_name: string;
      from_email_address: string;
      to: Array<{ name: string; address: string }> | null;
      cc: Array<{ name: string; address: string }> | null;
    };
    sender_email: {
      id: number;
      email: string;
      name: string;
    };
    lead?: {
      id?: number;
      email?: string;
      first_name?: string;
      last_name?: string;
      company?: string;
      custom_variables?: Record<string, { name: string; value: string }>;
    };
    campaign?: {
      id?: number;
      name?: string;
    };
  };
}

// ── Database Row Types ──

export interface Section {
  id: number;
  name: string;
  airtable_base_id: string;
  airtable_table_id: string;
  meeting_ready_table_id: string;
  clay_webhook_url_tracked: string | null;
  created_at: string;
}

export interface ClientTag {
  id: number;
  tag: string;
  section_id: number;
}

export interface UntrackedConfig {
  id: number;
  airtable_base_id: string;
  airtable_table_id: string;
  meeting_ready_table_id: string;
  clay_webhook_url: string | null;
}

export interface CompanyCode {
  id: number;
  code: string;
  pattern: string;
  priority: number;
}

export interface BounceFilter {
  id: number;
  field: string;
  value: string;
  match_type: string;
}

export interface ErrorLogEntry {
  id: number;
  timestamp: string;
  workflow: string;
  stage: string;
  message: string;
  payload: string | null;
}

export interface ActivityLogEntry {
  id: number;
  timestamp: string;
  workflow: string;
  client_tag: string | null;
  section_name: string | null;
  lead_email: string | null;
  action: string;
  details: string | null;
}

// ── Processing Types ──

export interface ExtractedCustomVars {
  phone: string;
  linkedin: string;
  city: string;
  state: string;
  google_maps_url: string;
  address: string;
}

export interface ExtractedRecipients {
  toEmails: string;
  toNames: string;
  ccEmails: string;
  ccNames: string;
  replyTime: string;
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

export interface SectionWithTags extends Section {
  tags: string[];
}
