/**
 * OutboundHero API helpers for sending replies, forwarding, and one-off emails.
 */

const API_BASE = "https://app.outboundhero.co/api";
const API_TOKEN = "60|QACwd4xuHycuYxLh8knGlKvKEuRkVSUw2obSpCNSd2ba2ebd";

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${API_TOKEN}`,
};

interface EmailRecipient {
  name: string;
  email_address: string;
}

export async function sendReply(params: {
  replyId: number;
  senderEmailId: number;
  message: string;
  toEmail: string;
  toName: string;
  ccEmails?: EmailRecipient[];
  bccEmails?: EmailRecipient[];
}): Promise<{ ok: boolean; error?: string }> {
  const payload: Record<string, unknown> = {
    inject_previous_email_body: true,
    message: params.message,
    sender_email_id: params.senderEmailId,
    content_type: "html",
    to_emails: [{ name: params.toName || "", email_address: params.toEmail }],
  };

  if (params.ccEmails?.length) payload.cc_emails = params.ccEmails;
  if (params.bccEmails?.length) payload.bcc_emails = params.bccEmails;

  const res = await fetch(`${API_BASE}/replies/${params.replyId}/reply`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (res.ok) return { ok: true };
  const body = await res.text();
  return { ok: false, error: `${res.status}: ${body}` };
}

export async function forwardReply(params: {
  replyId: number;
  senderEmailId: number;
  message: string;
  forwardTo: string;
  leadName: string;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/replies/${params.replyId}/forward?plain_text=true`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      inject_previous_email_body: true,
      message: params.message,
      sender_email_id: params.senderEmailId,
      content_type: "html",
      to_emails: [{ name: params.leadName || "", email_address: params.forwardTo }],
    }),
  });

  if (res.ok) return { ok: true };
  const body = await res.text();
  return { ok: false, error: `${res.status}: ${body}` };
}

export async function sendOneOffReply(params: {
  senderEmailId: number;
  subject: string;
  message: string;
  toEmail: string;
  toName: string;
  ccEmails?: EmailRecipient[];
}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/replies/new`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      subject: params.subject,
      message: params.message,
      sender_email_id: params.senderEmailId,
      content_type: "html",
      to_emails: [{ name: params.toName || "", email_address: params.toEmail }],
      cc_emails: params.ccEmails?.length ? params.ccEmails : null,
      bcc_emails: null,
      attachments: null,
    }),
  });

  if (res.ok) return { ok: true };
  const body = await res.text();
  return { ok: false, error: `${res.status}: ${body}` };
}

// ── Campaign / lead APIs (used by Nurture feature) ──────────────────────────

export interface OutboundCampaign {
  id: number;
  name: string;
  status: string;
  type: string;
  total_leads?: number;
  emails_sent?: number;
  replied?: number;
  bounced?: number;
}

export interface OutboundLead {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string;
  company: string | null;
  status: string;
  custom_variables?: Array<{ name: string; value: string }>;
  lead_campaign_data?: {
    status?: string;
    emails_sent?: number;
    replies?: number;
    opens?: number;
  } | [];
  overall_stats?: {
    emails_sent?: number;
    replies?: number;
    unique_replies?: number;
  };
  updated_at: string;
}

/** List ALL campaigns by paginating through every page. Filters client-side by name substring. */
export async function listCampaigns(opts?: { nameContains?: string }): Promise<OutboundCampaign[]> {
  const all: OutboundCampaign[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(`${API_BASE}/campaigns?page=${page}&per_page=100`, { headers });
    if (!res.ok) throw new Error(`listCampaigns failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const rows: OutboundCampaign[] = data?.data || [];
    if (rows.length === 0) break;
    all.push(...rows);
    const lastPage = data?.meta?.last_page ?? page;
    if (page >= lastPage) break;
    page++;
  }
  if (opts?.nameContains) {
    const needle = opts.nameContains.toLowerCase();
    return all.filter((c) => c.name?.toLowerCase().includes(needle));
  }
  return all;
}

/** List leads in a specific campaign filtered by lead_campaign_status. Paginates through all pages. */
export async function listCampaignLeads(
  campaignId: number,
  opts: { leadCampaignStatus?: string; perPage?: number } = {},
): Promise<OutboundLead[]> {
  const perPage = opts.perPage ?? 100;
  const all: OutboundLead[] = [];
  let page = 1;
  while (true) {
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    if (opts.leadCampaignStatus) params.set("filters.lead_campaign_status", opts.leadCampaignStatus);
    const res = await fetch(`${API_BASE}/campaigns/${campaignId}/leads?${params}`, { headers });
    if (!res.ok) throw new Error(`listCampaignLeads failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const rows: OutboundLead[] = data?.data || [];
    if (rows.length === 0) break;
    all.push(...rows);
    const lastPage = data?.meta?.last_page ?? page;
    if (page >= lastPage) break;
    page++;
  }
  return all;
}

/** Attach existing leads (by ID) to a campaign. Used to push qualified leads into a [Nurture] campaign. */
export async function attachLeadsToCampaign(
  campaignId: number,
  leadIds: number[],
  allowParallelSending = false,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const res = await fetch(`${API_BASE}/campaigns/${campaignId}/leads/attach-leads`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      allow_parallel_sending: allowParallelSending,
      lead_ids: leadIds,
    }),
  });
  const body = await res.json().catch(() => null);
  if (res.ok) return { ok: true, message: body?.data?.message };
  return { ok: false, error: `${res.status}: ${JSON.stringify(body)}` };
}

/** Find a single lead by email (search). Returns the first matching lead or null. */
export async function findLeadByEmail(email: string): Promise<OutboundLead | null> {
  const res = await fetch(`${API_BASE}/leads?search=${encodeURIComponent(email)}&per_page=10`, { headers });
  if (!res.ok) return null;
  const data = await res.json();
  const rows: OutboundLead[] = data?.data || [];
  return rows.find((r) => r.email?.toLowerCase() === email.toLowerCase()) || rows[0] || null;
}
