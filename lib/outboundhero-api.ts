/**
 * Bison (EmailBison) API helpers — instance-aware.
 *
 * Every exported function takes an `instanceKey` as its first parameter,
 * looked up via `lib/bison-instances.ts`. This module no longer has any
 * hardcoded base URL or token — those come from the registry + env vars.
 *
 * Callers that don't know which instance to use should resolve it from
 * the row's `bison_instance` column (for existing rows) or via
 * `resolveInstanceForClient(clientTag)` (for new actions keyed by client).
 */

import { getInstanceConfig } from "@/lib/bison-instances";

function buildHeaders(token: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Wrap fetch with a hard timeout via AbortController.
 *
 * Bison endpoints occasionally hang indefinitely (no response, no error).
 * Without this, a single hung call would consume the entire serverless
 * function budget and silently kill the cron — exactly what happened to
 * the nurture sync between 2026-06-02 and 2026-06-08.
 */
async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 45_000, ...rest } = init;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

interface EmailRecipient {
  name: string;
  email_address: string;
}

export async function sendReply(
  instanceKey: string,
  params: {
    replyId: number;
    senderEmailId: number;
    message: string;
    toEmail: string;
    toName: string;
    ccEmails?: EmailRecipient[];
    bccEmails?: EmailRecipient[];
  },
): Promise<{ ok: boolean; error?: string }> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const payload: Record<string, unknown> = {
    inject_previous_email_body: true,
    message: params.message,
    sender_email_id: params.senderEmailId,
    content_type: "html",
    to_emails: [{ name: params.toName || "", email_address: params.toEmail }],
  };

  if (params.ccEmails?.length) payload.cc_emails = params.ccEmails;
  if (params.bccEmails?.length) payload.bcc_emails = params.bccEmails;

  const res = await fetchWithTimeout(`${baseUrl}/api/replies/${params.replyId}/reply`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(payload),
  });

  if (res.ok) return { ok: true };
  const body = await res.text();
  return { ok: false, error: `${res.status}: ${body}` };
}

export async function forwardReply(
  instanceKey: string,
  params: {
    replyId: number;
    senderEmailId: number;
    message: string;
    forwardTo: string;
    leadName: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/replies/${params.replyId}/forward?plain_text=true`, {
    method: "POST",
    headers: buildHeaders(token),
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

export async function sendOneOffReply(
  instanceKey: string,
  params: {
    senderEmailId: number;
    subject: string;
    message: string;
    toEmail: string;
    toName: string;
    ccEmails?: EmailRecipient[];
  },
): Promise<{ ok: boolean; error?: string }> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/replies/new`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify({
      subject: params.subject,
      message: params.message,
      sender_email_id: params.senderEmailId,
      content_type: "html",
      to_emails: [{ name: params.toName || "", email_address: params.toEmail }],
      // OB now rejects nulls for these — must be empty arrays. Hit during
      // a Change-of-Target re-pitch:
      //   422: "The cc emails field must be an array. (and 2 more errors)"
      cc_emails: params.ccEmails?.length ? params.ccEmails : [],
      bcc_emails: [],
      attachments: [],
    }),
  });

  if (res.ok) return { ok: true };
  const body = await res.text();
  return { ok: false, error: `${res.status}: ${body}` };
}

// ── Campaign / lead APIs (used by Nurture feature) ──────────────────────────

export interface OutboundCampaign {
  id: number;
  /** UUID-style identifier OutboundHero uses in dashboard URLs (e.g. /campaigns/{uuid}). Distinct from the numeric `id` used by the API. */
  uuid?: string | null;
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

/**
 * List ALL campaigns by paginating through every page. Filters client-side by name substring.
 *
 * Captures whichever UUID-shaped identifier OutboundHero exposes — used to
 * build dashboard URLs like /campaigns/{uuid}. The API's numeric `id` is
 * what attach-leads / list-leads actually consume, so both are kept.
 */
function pickUuid(row: Record<string, unknown>): string | null {
  // Defensive: OB has used different field names in the past. Try the
  // most common ones and pick the first that looks like a UUID.
  const candidates = ["uuid", "public_id", "external_id", "campaign_uuid", "slug"];
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const k of candidates) {
    const v = row[k];
    if (typeof v === "string" && uuidLike.test(v)) return v;
  }
  // Last resort: scan all string fields for one that matches UUID shape.
  for (const v of Object.values(row)) {
    if (typeof v === "string" && uuidLike.test(v)) return v;
  }
  return null;
}

export async function listCampaigns(
  instanceKey: string,
  opts?: { nameContains?: string },
): Promise<OutboundCampaign[]> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const headers = buildHeaders(token);
  const PER_PAGE = 100;
  // Higher concurrency + tighter per-page timeout so large instances
  // (outboundhero / facilityreach) complete the page sweep inside the
  // 3-min instance budget. With outboundhero hanging 45 s per page at
  // CONCURRENCY=6, the math couldn't fit.
  const CONCURRENCY = 12;
  const PAGE_TIMEOUT_MS = 20_000;

  // Fetch one page from the upstream API and normalise to OutboundCampaign[].
  async function fetchPage(page: number): Promise<{ rows: OutboundCampaign[]; lastPage: number }> {
    const res = await fetchWithTimeout(`${baseUrl}/api/campaigns?page=${page}&per_page=${PER_PAGE}`, { headers, timeoutMs: PAGE_TIMEOUT_MS });
    if (!res.ok) throw new Error(`listCampaigns(${instanceKey}) page ${page} failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const rawRows: Array<Record<string, unknown>> = data?.data || [];
    const lastPage = (data?.meta?.last_page as number | undefined) ?? page;
    const rows: OutboundCampaign[] = rawRows.map((row) => ({
      id: row.id as number,
      uuid: pickUuid(row),
      name: (row.name as string) ?? "",
      status: (row.status as string) ?? "",
      type: (row.type as string) ?? "",
      total_leads: row.total_leads as number | undefined,
      emails_sent: row.emails_sent as number | undefined,
      replied: row.replied as number | undefined,
      bounced: row.bounced as number | undefined,
    }));
    return { rows, lastPage };
  }

  // Page 1 first — gives us the total page count via meta.last_page.
  const { rows: first, lastPage } = await fetchPage(1);

  // Sequential pagination was the bottleneck: ~30 pages × 300 ms each is
  // ~9 s. Fetch pages 2..last_page in parallel with bounded concurrency.
  const pagesToFetch: number[] = [];
  for (let p = 2; p <= lastPage; p++) pagesToFetch.push(p);

  const results: OutboundCampaign[][] = new Array(pagesToFetch.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pagesToFetch.length) }, async () => {
      while (idx < pagesToFetch.length) {
        const myIdx = idx++;
        try {
          const r = await fetchPage(pagesToFetch[myIdx]);
          results[myIdx] = r.rows;
        } catch (e) {
          console.warn(`[outboundhero:${instanceKey}] listCampaigns page error:`, (e as Error).message);
          results[myIdx] = [];
        }
      }
    }),
  );

  const all = first.concat(...results);
  if (opts?.nameContains) {
    const needle = opts.nameContains.toLowerCase();
    return all.filter((c) => c.name?.toLowerCase().includes(needle));
  }
  return all;
}

/** List leads in a specific campaign filtered by lead_campaign_status. Paginates through all pages. */
export async function listCampaignLeads(
  instanceKey: string,
  campaignId: number,
  opts: { leadCampaignStatus?: string; perPage?: number } = {},
): Promise<OutboundLead[]> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const headers = buildHeaders(token);
  const perPage = opts.perPage ?? 100;
  const all: OutboundLead[] = [];
  let page = 1;
  while (true) {
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    if (opts.leadCampaignStatus) params.set("filters.lead_campaign_status", opts.leadCampaignStatus);
    // Tighter timeout (20 s) so a single slow page on facilityreach /
    // outboundhero doesn't burn the per-campaign budget.
    const res = await fetchWithTimeout(`${baseUrl}/api/campaigns/${campaignId}/leads?${params}`, { headers, timeoutMs: 20_000 });
    if (!res.ok) throw new Error(`listCampaignLeads(${instanceKey}, ${campaignId}) failed: ${res.status} ${await res.text()}`);
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

/**
 * Attach existing leads (by ID) to a campaign. Used to push qualified leads
 * into a [Nurture] campaign.
 *
 * `allowParallelSending` defaults to `true` — without it, OutboundHero
 * silently drops any lead that is already in another active campaign and
 * still returns 200 OK. We learned this the hard way: a 90-lead push
 * recorded 89 as "added" in our dashboard but only 8 actually attached
 * because the other 81 were already in their original outbound campaigns.
 *
 * The response is parsed for the actual attached count when possible. If
 * the count returned is lower than the count we sent, the caller MUST NOT
 * mark all leads as added — see app/api/nurture/mutate/route.ts.
 */
export async function attachLeadsToCampaign(
  instanceKey: string,
  campaignId: number,
  leadIds: number[],
  allowParallelSending = true,
): Promise<{
  ok: boolean;
  /** Number of leads OutboundHero confirmed as attached. null = unknown (response didn't include a count). */
  attachedCount: number | null;
  /** Number of leads we sent in the request. */
  requestedCount: number;
  message?: string;
  error?: string;
  /** Raw response body for diagnostics. */
  raw?: unknown;
}> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/campaigns/${campaignId}/leads/attach-leads`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify({
      allow_parallel_sending: allowParallelSending,
      lead_ids: leadIds,
    }),
  });
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    return {
      ok: false,
      attachedCount: null,
      requestedCount: leadIds.length,
      error: `${res.status}: ${JSON.stringify(body)}`,
      raw: body,
    };
  }

  // Try several shapes OutboundHero may return for the attached count.
  // We've seen `data.message` in success responses; the count fields below
  // are defensive — if none match we treat the count as unknown and the
  // caller decides whether to trust the request size.
  const data = body?.data ?? body ?? {};
  const candidates = [
    data?.attached_count,
    data?.attached,
    data?.successful_count,
    data?.success_count,
    data?.created_count,
    data?.added_count,
    Array.isArray(data?.attached_lead_ids) ? data.attached_lead_ids.length : undefined,
    Array.isArray(data?.attached_leads) ? data.attached_leads.length : undefined,
  ];
  const attachedCount = candidates.find((v) => typeof v === "number" && Number.isFinite(v)) as number | undefined;

  // Log full body whenever the count is missing or doesn't match — this
  // gives us the data we need to harden the parser if the API shape
  // changes. Stringified once, never spammy.
  if (attachedCount === undefined || attachedCount !== leadIds.length) {
    console.log(
      `[outboundhero:${instanceKey}] attach-leads response (campaign ${campaignId}, requested ${leadIds.length}, parsed attached=${attachedCount ?? "unknown"}):`,
      JSON.stringify(body),
    );
  }

  return {
    ok: true,
    attachedCount: attachedCount ?? null,
    requestedCount: leadIds.length,
    message: data?.message,
    raw: body,
  };
}

/**
 * Sent-email record returned by GET /leads/{leadId}/sent-emails.
 * Only the fields we currently consume are typed — the upstream payload is
 * much larger.
 */
export interface OutboundSentEmail {
  id: number;
  campaign_id: number;
  email_subject: string;
  email_body: string;
  status: string;
  scheduled_date: string;
  sent_at: string | null;
  thread_reply: boolean;
  sender_email: { id: number; name: string; email: string } | null;
}

/**
 * Fetch every sent email we've delivered to a given lead, in OB's native
 * order (newest by id desc). Used by the Change-of-Target workflow to
 * find the very first cold email so we can re-pitch it to a redirected
 * contact.
 */
export async function getSentEmails(instanceKey: string, leadId: number): Promise<OutboundSentEmail[]> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/leads/${leadId}/sent-emails`, { headers: buildHeaders(token) });
  if (!res.ok) {
    throw new Error(`getSentEmails(${instanceKey}, ${leadId}) failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  // Upstream wraps the array in an extra { data: [{ data: [...] }] } envelope
  // (per the example payload), so unwrap defensively.
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) {
    const inner = data.data;
    if (inner.length && Array.isArray(inner[0]?.data)) return inner[0].data;
    return inner as OutboundSentEmail[];
  }
  return [];
}

/**
 * The first email we sent to this lead in a given campaign — the original
 * cold pitch for that specific campaign. "First" = oldest sent_at.
 *
 * Why scoped to campaign: a lead is often touched by multiple campaigns
 * over time. The Change-of-Target re-pitch needs to mirror the cold
 * email from the SAME campaign as the reply we're acting on, not some
 * older / unrelated outreach. Pass campaignId to honor that.
 *
 * Pass campaignId = null to get the absolute-first across any campaign
 * (the legacy behavior — kept for callers that don't have campaign context).
 */
export async function getFirstSentEmail(
  instanceKey: string,
  leadId: number,
  campaignId: number | null = null,
): Promise<OutboundSentEmail | null> {
  const all = await getSentEmails(instanceKey, leadId);
  const scoped = campaignId == null ? all : all.filter((e) => e.campaign_id === campaignId);
  if (scoped.length === 0) return null;
  // Sort ascending by sent_at; fall back to id for emails without sent_at.
  const withTime = scoped.filter((e) => e.sent_at);
  const sorted = (withTime.length ? withTime : scoped).sort((a, b) => {
    if (a.sent_at && b.sent_at) return a.sent_at.localeCompare(b.sent_at);
    return a.id - b.id;
  });
  return sorted[0] || null;
}

/** Find a single lead by email (search). Returns the first matching lead or null. */
export async function findLeadByEmail(instanceKey: string, email: string): Promise<OutboundLead | null> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/leads?search=${encodeURIComponent(email)}&per_page=10`, { headers: buildHeaders(token) });
  if (!res.ok) return null;
  const data = await res.json();
  const rows: OutboundLead[] = data?.data || [];
  return rows.find((r) => r.email?.toLowerCase() === email.toLowerCase()) || rows[0] || null;
}
