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
async function fetchOnce(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 45_000, ...rest } = init;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Like fetchOnce but transparently retries Bison's 429 ("Too Many Attempts")
 * and 503 with exponential backoff (honouring Retry-After when present). Bison
 * rate-limits aggressively under concurrency; without this, paginated pulls
 * silently drop pages and undercount. Up to 6 attempts: ~1s,2s,4s,8s,16s.
 */
async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const MAX_RETRIES = 6;
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetchOnce(url, init);
    } catch (e) {
      // Network/abort errors are also worth a couple of retries.
      if (attempt >= 2) throw e;
      await sleep(backoffMs(attempt));
      attempt++;
      continue;
    }
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
      await sleep(waitMs);
      attempt++;
      continue;
    }
    return res;
  }
}

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s, 8s, 16s, capped at 20s. Small fixed jitter by attempt parity
  // (Math.random is unavailable in some runtimes here).
  const base = Math.min(20_000, 1000 * 2 ** attempt);
  return base + (attempt % 2 === 0 ? 250 : 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
  /**
   * Tags attached to the lead in Bison. Includes Bison's built-in
   * mailbox-provider tags (Outlook, Google, Custom Mail Server,
   * Proofpoint, Mimecast, Barracuda, Zoho — all `default: true`)
   * alongside operator-added segmentation tags. `pickEspFromTags()`
   * in `lib/nurture/esp.ts` filters down to the ESP one.
   */
  tags?: Array<{
    id: number;
    name: string;
    default?: boolean;
  }>;
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
  opts?: { nameContains?: string; statuses?: string[]; search?: string },
): Promise<OutboundCampaign[]> {
  // Bison rejects multi-status in one call ("The selected status is
  // invalid."), so fan out — one status-scoped paginated call per status,
  // in parallel, then merge + dedupe.
  if (opts?.statuses && opts.statuses.length > 0) {
    const perStatus = await Promise.all(
      opts.statuses.map((s) => listCampaignsForStatus(instanceKey, s, opts))
    );
    const byId = new Map<number, OutboundCampaign>();
    for (const arr of perStatus) for (const c of arr) byId.set(c.id, c);
    return Array.from(byId.values());
  }
  return listCampaignsForStatus(instanceKey, undefined, opts);
}

async function listCampaignsForStatus(
  instanceKey: string,
  status: string | undefined,
  opts?: { nameContains?: string; search?: string },
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

  function buildUrl(page: number) {
    const params = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
    if (status) params.set("status", status);
    if (opts?.search) params.set("search", opts.search);
    return `${baseUrl}/api/campaigns?${params}`;
  }

  // Fetch one page from the upstream API and normalise to OutboundCampaign[].
  async function fetchPage(page: number): Promise<{ rows: OutboundCampaign[]; lastPage: number }> {
    const res = await fetchWithTimeout(buildUrl(page), { headers, timeoutMs: PAGE_TIMEOUT_MS });
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

/**
 * List leads in a specific campaign filtered by lead_campaign_status.
 *
 * Page 1 is fetched first to learn `meta.last_page`. Then pages 2..N are
 * fetched in parallel with bounded concurrency. This matters for
 * high-volume clients (e.g. JPNYC has campaigns with 50+ pages of
 * sequence_finished leads) — serial pagination at ~1s per page would
 * take 50+ seconds per campaign and bust the per-instance time budget.
 */
export async function listCampaignLeads(
  instanceKey: string,
  campaignId: number,
  opts: { leadCampaignStatus?: string; perPage?: number; maxPages?: number } = {},
): Promise<OutboundLead[]> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const headers = buildHeaders(token);
  const perPage = opts.perPage ?? 100;
  const PAGE_TIMEOUT_MS = 12_000;
  // Bison rate-limits the campaign-leads endpoint under concurrency. 3 keeps
  // us mostly clear; the 429 retry/backoff in fetchWithTimeout covers the rest
  // so pages are never silently dropped.
  const PAGE_CONCURRENCY = 3;
  // maxPages cap protects the autonomous per-instance cron from
  // mega-campaigns (JPNYC has one with 1,021 pages, ~17 min serial /
  // 3 min parallel). Per-client / manual callers can pass Infinity.
  const maxPages = opts.maxPages ?? Infinity;

  function url(page: number) {
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    // The ONLY filter form Bison honors is `filters[lead_campaign_status]`
    // (plural + brackets). `filters.lead_campaign_status` (dot) and
    // `filter[...]` (singular) are silently ignored — Bison returns the
    // full unfiltered set, so the sync would page the newest in_sequence
    // leads and find ~0 finished. Append the brackets RAW (URLSearchParams
    // percent-encodes them) to match the verified-working request exactly.
    let qs = params.toString();
    if (opts.leadCampaignStatus) qs += `&filters[lead_campaign_status]=${opts.leadCampaignStatus}`;
    return `${baseUrl}/api/campaigns/${campaignId}/leads?${qs}`;
  }

  async function fetchPage(page: number): Promise<{ rows: OutboundLead[]; lastPage: number }> {
    const res = await fetchWithTimeout(url(page), { headers, timeoutMs: PAGE_TIMEOUT_MS });
    if (!res.ok) throw new Error(`listCampaignLeads(${instanceKey}, ${campaignId}) page ${page} failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const rows: OutboundLead[] = data?.data || [];
    const lastPage = (data?.meta?.last_page as number | undefined) ?? page;
    return { rows, lastPage };
  }

  const first = await fetchPage(1);
  if (first.rows.length === 0 || first.lastPage <= 1) return first.rows;

  // Pages 2..lastPage in parallel with bounded concurrency.
  const effectiveLast = Math.min(first.lastPage, maxPages);
  const pages: number[] = [];
  for (let p = 2; p <= effectiveLast; p++) pages.push(p);
  const results: OutboundLead[][] = new Array(pages.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(PAGE_CONCURRENCY, pages.length) }, async () => {
      while (idx < pages.length) {
        const my = idx++;
        try {
          const r = await fetchPage(pages[my]);
          results[my] = r.rows;
        } catch (e) {
          console.warn(`[${instanceKey}:${campaignId}] page ${pages[my]} failed:`, (e as Error).message);
          results[my] = [];
        }
      }
    }),
  );
  return first.rows.concat(...results);
}

/**
 * Fetch ONE page range of a campaign's leads — pages [startPage, startPage+pageCount).
 * Returns the rows plus the campaign's `last_page`, so a caller can page through
 * a campaign with live progress (used by the source-campaign router) instead of
 * pulling the whole campaign at once. Concurrent within the range, with the same
 * 429-backoff `fetchWithTimeout` as listCampaignLeads.
 */
export async function getCampaignLeadsPage(
  instanceKey: string,
  campaignId: number,
  startPage: number,
  pageCount: number,
  opts: { perPage?: number; leadCampaignStatus?: string } = {},
): Promise<{ leads: OutboundLead[]; lastPage: number }> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const headers = buildHeaders(token);
  const perPage = opts.perPage ?? 100;
  // `filters[lead_campaign_status]` (plural+brackets) is the ONLY form Bison
  // honors; append it RAW (URLSearchParams percent-encodes the brackets).
  const filter = opts.leadCampaignStatus ? `&filters[lead_campaign_status]=${opts.leadCampaignStatus}` : "";
  const url = (page: number) => `${baseUrl}/api/campaigns/${campaignId}/leads?page=${page}&per_page=${perPage}${filter}`;
  async function fetchPage(page: number): Promise<{ rows: OutboundLead[]; lastPage: number }> {
    const res = await fetchWithTimeout(url(page), { headers, timeoutMs: 15_000 });
    if (!res.ok) return { rows: [], lastPage: page };
    const data = await res.json().catch(() => null);
    return { rows: (data?.data ?? []) as OutboundLead[], lastPage: Number(data?.meta?.last_page) || page };
  }
  const start = Math.max(1, startPage);
  const pages = Array.from({ length: Math.max(1, pageCount) }, (_, i) => start + i);
  const out: OutboundLead[] = [];
  let lastPage = start;
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(16, pages.length) }, async () => {
    while (idx < pages.length) {
      const p = pages[idx++];
      const r = await fetchPage(p);
      lastPage = Math.max(lastPage, r.lastPage);
      if (r.rows.length) out.push(...r.rows);
    }
  }));
  return { leads: out, lastPage };
}

/**
 * Enumerate ALL of a campaign's leads via CURSOR pagination.
 *
 * Traditional page pagination is capped by Bison at 1000 pages (= 15,000 leads,
 * since per_page is locked to 15), so it cannot reach the tail of large
 * campaigns. Cursor pagination has no such cap — we follow `meta.next_cursor`
 * until it's null. It's inherently sequential (each request needs the previous
 * response's cursor) and still returns ~15 rows/request, so this is slow
 * (~N/15 requests) — use it for one-time/background full sweeps, not live UI.
 * See https://docs.emailbison.com/get-started/pagination .
 */
export async function listCampaignLeadsCursor(
  instanceKey: string,
  campaignId: number,
  opts: { leadCampaignStatus?: string; onProgress?: (fetched: number) => void } = {},
): Promise<OutboundLead[]> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const headers = buildHeaders(token);
  const filter = opts.leadCampaignStatus ? `&filters[lead_campaign_status]=${opts.leadCampaignStatus}` : "";
  const out: OutboundLead[] = [];
  let cursor: string | null = null;
  let guard = 0;
  let retries = 0; // consecutive failures on the CURRENT cursor position
  for (;;) {
    const url = `${baseUrl}/api/campaigns/${campaignId}/leads?pagination_type=cursor&per_page=100${filter}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { headers, timeoutMs: 30_000 });
    } catch {
      // Timeout / network abort — retry the SAME cursor with backoff instead of
      // throwing (an unhandled throw here would crash a whole bulk sweep). Give
      // up on the remaining pages after several tries and return what we have.
      if (++retries <= 6) { await new Promise((r) => setTimeout(r, 1500 * retries)); continue; }
      break;
    }
    if (!res.ok) {
      if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      if ((res.status === 502 || res.status === 503 || res.status === 504) && ++retries <= 6) {
        await new Promise((r) => setTimeout(r, 1500 * retries)); continue;
      }
      break;
    }
    retries = 0;
    const data = await res.json().catch(() => null);
    const rows = (data?.data ?? []) as OutboundLead[];
    if (rows.length) { out.push(...rows); opts.onProgress?.(out.length); }
    const next = (data?.meta?.next_cursor as string | null | undefined) ?? null;
    if (!next || rows.length === 0) break;
    cursor = next;
    if (++guard > 200_000) break; // hard safety stop
  }
  return out;
}

/**
 * Count of leads in a campaign, optionally filtered by lead_campaign_status
 * (e.g. "sequence_finished"). One cheap request — reads meta.total from page 1.
 */
export async function getCampaignLeadCount(
  instanceKey: string,
  campaignId: number,
  leadCampaignStatus?: string,
): Promise<number> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const filter = leadCampaignStatus ? `&filters[lead_campaign_status]=${leadCampaignStatus}` : "";
  const res = await fetchWithTimeout(
    `${baseUrl}/api/campaigns/${campaignId}/leads?page=1&per_page=1${filter}`,
    { headers: buildHeaders(token), timeoutMs: 15_000 },
  );
  if (!res.ok) return 0;
  const data = await res.json().catch(() => null);
  return Number(data?.meta?.total) || 0;
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
interface AttachResult {
  ok: boolean;
  /** Number of leads OutboundHero confirmed as attached. null = unknown (response didn't include a count). */
  attachedCount: number | null;
  /** Number of leads we sent in the request. */
  requestedCount: number;
  message?: string;
  error?: string;
  /** Raw response body for diagnostics. */
  raw?: unknown;
}

// Attaching too many lead_ids in one request makes Bison time out ("This
// operation was aborted") — ~40k leads reliably aborts. Chunk so each request
// stays small + fast.
const ATTACH_CHUNK = 1000;

/**
 * Attach leads to a campaign. Large lists are split into chunks of ATTACH_CHUNK
 * and attached sequentially, then aggregated — a single 40k-lead request aborts.
 */
export async function attachLeadsToCampaign(
  instanceKey: string,
  campaignId: number,
  leadIds: number[],
  allowParallelSending = true,
): Promise<AttachResult> {
  if (leadIds.length <= ATTACH_CHUNK) {
    return attachLeadsBatch(instanceKey, campaignId, leadIds, allowParallelSending);
  }
  let attached = 0;
  let allOk = true;
  let firstErr: string | undefined;
  for (let i = 0; i < leadIds.length; i += ATTACH_CHUNK) {
    const r = await attachLeadsBatch(instanceKey, campaignId, leadIds.slice(i, i + ATTACH_CHUNK), allowParallelSending);
    if (r.ok) attached += r.attachedCount ?? r.requestedCount;
    else { allOk = false; if (!firstErr) firstErr = r.error; }
  }
  return { ok: allOk, attachedCount: attached, requestedCount: leadIds.length, error: firstErr };
}

async function attachLeadsBatch(
  instanceKey: string,
  campaignId: number,
  leadIds: number[],
  allowParallelSending = true,
): Promise<AttachResult> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/campaigns/${campaignId}/leads/attach-leads`, {
    method: "POST",
    headers: buildHeaders(token),
    timeoutMs: 120_000, // a 1k-lead attach can take a while server-side
    body: JSON.stringify({
      allow_parallel_sending: allowParallelSending,
      lead_ids: leadIds,
    }),
  });
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    // Bison returns 422 "No leads were added because they are either in other
    // sequences, have previously bounced, or unsubscribed" when EVERY lead in
    // the batch is already placed (e.g. an idempotent re-run). The leads are
    // already in nurture, so treat this as success-with-0-newly-added — callers
    // (route engine) then still stamp/record them rather than erroring out.
    const msg = JSON.stringify(body ?? "");
    if (res.status === 422 && /in other sequences|already|existing|unsubscrib/i.test(msg)) {
      return { ok: true, attachedCount: 0, requestedCount: leadIds.length, message: "already present", raw: body };
    }
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
 * Resume (activate) a campaign so it starts/continues sending.
 *   PATCH /api/campaigns/{id}/resume
 * Used after attaching nurture leads to a draft/paused campaign. Idempotent
 * on Bison's side — resuming an already-active campaign is a no-op.
 */
export async function resumeCampaign(
  instanceKey: string,
  campaignId: number,
): Promise<{ ok: boolean; status?: number; error?: string; raw?: unknown }> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/campaigns/${campaignId}/resume`, {
    method: "PATCH",
    headers: buildHeaders(token),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, status: res.status, error: `${res.status}: ${JSON.stringify(body)}`, raw: body };
  }
  return { ok: true, status: res.status, raw: body };
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

/**
 * Find a single lead by email. Returns the matching lead or null.
 *
 * Uses the direct path lookup `GET /api/leads/{email}` (Bison resolves the
 * email as a lead identifier) rather than the `?search=` query endpoint. The
 * search endpoint was returning HTTP 504 (server-side timeout, ~100s/call) and
 * stalled the ESP backfill; the path endpoint returns in ~200-600ms with the
 * same `{ data: {...lead, tags:[…]} }` shape. A missing lead returns 404 (with
 * a `{data:{success:false}}` body), which we map to null via the !res.ok guard.
 */
export async function findLeadByEmail(instanceKey: string, email: string): Promise<OutboundLead | null> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/leads/${encodeURIComponent(email)}`, { headers: buildHeaders(token) });
  if (!res.ok) return null; // 404 = not found, anything else = transient/error
  const data = await res.json();
  const lead = (data?.data ?? data) as OutboundLead | undefined;
  // Guard against the 404-with-200 edge: only treat it as a hit if it has an id.
  if (!lead || typeof lead.id !== "number") return null;
  return lead;
}

// Per-process cache of known custom-variable names per instance, so a routing
// run doesn't re-list/re-create the same variables for every batch.
const _customVarCache = new Map<string, Set<string>>();

/** List the custom-variable names defined in an instance. */
export async function listCustomVariables(instanceKey: string): Promise<string[]> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/custom-variables?per_page=1000`, { headers: buildHeaders(token) });
  if (!res.ok) return [];
  const body = await res.json().catch(() => null);
  const rows: Array<{ name?: string }> = body?.data ?? [];
  return rows.map((r) => String(r.name)).filter(Boolean);
}

/**
 * Ensure every named custom variable exists in the target instance, creating
 * any that are missing. Required before createLeadsInInstance can attach custom
 * variables: Bison 422s the whole lead batch if a referenced variable doesn't
 * exist in that workspace. Idempotent — "already been taken" is treated as OK.
 */
export async function ensureCustomVariables(
  instanceKey: string,
  names: string[],
): Promise<{ created: string[]; existing: string[]; errors: string[] }> {
  const out = { created: [] as string[], existing: [] as string[], errors: [] as string[] };
  const wanted = [...new Set(names.map((n) => (n || "").trim()).filter(Boolean))];
  if (wanted.length === 0) return out;
  let known = _customVarCache.get(instanceKey);
  if (!known) {
    known = new Set((await listCustomVariables(instanceKey)).map((n) => n.toLowerCase()));
    _customVarCache.set(instanceKey, known);
  }
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  for (const name of wanted) {
    if (known.has(name.toLowerCase())) { out.existing.push(name); continue; }
    const res = await fetchWithTimeout(`${baseUrl}/api/custom-variables`, {
      method: "POST", headers: buildHeaders(token), body: JSON.stringify({ name }),
    });
    if (res.ok) { out.created.push(name); known.add(name.toLowerCase()); continue; }
    const body = await res.json().catch(() => null);
    const msg = JSON.stringify(body) || "";
    if (res.status === 422 && /already been taken/i.test(msg)) { out.existing.push(name); known.add(name.toLowerCase()); }
    else out.errors.push(`${name}: ${res.status} ${msg.slice(0, 120)}`);
  }
  return out;
}

export interface CreateLeadInput {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  notes?: string | null;
  custom_variables?: Array<{ name: string; value: string }>;
}

/**
 * Bulk-create leads in a specific Bison instance via POST /api/leads/multiple
 * (≤500 per request). Returns the instance-specific lead id per email — this is
 * how cross-instance nurture routing places a lead into the correct workspace
 * (B2B#1/#2, B2C#1/#2) before attaching it to that workspace's campaign.
 *
 * Bison returns `{ data: [{ id, email, ... }] }`. Emails NOT echoed back are
 * `notReturned` — typically a personal domain on an instance that hasn't
 * enabled them, or a dedupe the API didn't surface — and the caller should
 * fall back to findLeadByEmail (the lead may already exist there).
 */
export async function createLeadsInInstance(
  instanceKey: string,
  leads: CreateLeadInput[],
  opts: { ensureVars?: boolean } = {},
): Promise<{ created: Array<{ email: string; ob_lead_id: number }>; notReturned: string[]; errors: string[] }> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const created: Array<{ email: string; ob_lead_id: number }> = [];
  const notReturned: string[] = [];
  const errors: string[] = [];

  // Custom-variable names are CASE-SENSITIVE on reference but Bison's canonical
  // vars are lowercase, and the source data has inconsistent casing
  // ("City"/"city"). Normalise names to lowercase everywhere so ensure +
  // reference agree (otherwise "You do not have a custom variable named City"
  // 422s the batch). Values are left untouched.
  const normVars = (cv?: Array<{ name: string; value: string }>) =>
    (cv || []).filter((v) => v && v.name).map((v) => ({ name: v.name.toLowerCase().trim(), value: v.value }));

  // A referenced custom variable that doesn't exist in this workspace 422s the
  // ENTIRE batch — so make sure they all exist first (default on). Cheap after
  // the first call thanks to the per-instance cache.
  if (opts.ensureVars !== false) {
    const varNames = [...new Set(leads.flatMap((l) => normVars(l.custom_variables).map((v) => v.name)))];
    if (varNames.length > 0) {
      const r = await ensureCustomVariables(instanceKey, varNames);
      if (r.errors.length) errors.push(...r.errors.map((e) => `custom-var: ${e}`));
    }
  }

  const toPayload = (l: CreateLeadInput) => {
    const cv = normVars(l.custom_variables);
    return {
      email: l.email,
      ...(l.first_name != null ? { first_name: l.first_name } : {}),
      ...(l.last_name != null ? { last_name: l.last_name } : {}),
      ...(l.company != null ? { company: l.company } : {}),
      ...(l.title != null ? { title: l.title } : {}),
      ...(l.notes != null ? { notes: l.notes } : {}),
      ...(cv.length ? { custom_variables: cv } : {}),
    };
  };

  // Post one chunk via the UPSERT endpoint (create-or-update). With
  // existing_lead_behavior="patch" Bison creates new leads and patches existing
  // ones (updating passed fields/custom-vars, keeping the rest) — and returns an
  // id for BOTH, so there's no "already been taken" 422 and no findLeadByEmail
  // dance. A missing custom variable still 422s → auto-create + retry. Other
  // hard errors split so one bad lead can't sink the batch.
  async function postChunk(chunk: CreateLeadInput[], depth: number): Promise<void> {
    if (chunk.length === 0) return;
    const res = await fetchWithTimeout(`${baseUrl}/api/leads/create-or-update/multiple`, {
      method: "POST", headers: buildHeaders(token),
      body: JSON.stringify({ existing_lead_behavior: "patch", leads: chunk.map(toPayload) }),
      timeoutMs: 30_000,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = JSON.stringify(body) || "";
      // Missing custom variable → "You do not have a custom variable named X".
      // Auto-create the named variable(s) and retry the same chunk (depth-guarded).
      if (res.status === 422 && /do not have a custom variable named/i.test(msg) && depth < 6) {
        const names = [...msg.matchAll(/custom variable named ([^."\\]+)/gi)].map((m) => m[1].trim()).filter(Boolean);
        if (names.length) {
          await ensureCustomVariables(instanceKey, names);
          await postChunk(chunk, depth + 1);
          return;
        }
      }
      // Other hard error → split to isolate a malformed lead; size-1 is recorded.
      if (chunk.length === 1) {
        errors.push(`HTTP ${res.status} (${chunk[0].email}): ${msg.slice(0, 200)}`);
        notReturned.push(chunk[0].email);
        return;
      }
      const mid = Math.floor(chunk.length / 2);
      await postChunk(chunk.slice(0, mid), depth + 1);
      await postChunk(chunk.slice(mid), depth + 1);
      return;
    }
    const rows: Array<{ id?: number; email?: string }> = body?.data ?? [];
    const byEmail = new Map<string, number>();
    for (const r of rows) if (r?.email && r?.id) byEmail.set(String(r.email).toLowerCase(), Number(r.id));
    for (const l of chunk) {
      const id = byEmail.get(l.email.toLowerCase());
      if (id) created.push({ email: l.email, ob_lead_id: id }); // created OR patched — both carry an id
      else notReturned.push(l.email); // only personal-domain-skipped on a non-enabled instance
    }
  }

  const BATCH = 500;
  for (let i = 0; i < leads.length; i += BATCH) {
    await postChunk(leads.slice(i, i + BATCH), 0);
  }
  return { created, notReturned, errors };
}

/**
 * PATCH a lead's custom variables in an instance. Used to backfill custom
 * variables onto leads that already exist there (createLeadsInInstance is a
 * no-op for existing emails — it neither updates fields nor custom variables).
 */
export async function updateLeadCustomVars(
  instanceKey: string,
  leadId: number,
  customVars: Array<{ name: string; value: string }>,
): Promise<boolean> {
  if (!customVars.length) return true;
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  // Same lowercase normalisation as createLeadsInInstance (case-sensitive names).
  const cv = customVars.filter((v) => v && v.name).map((v) => ({ name: v.name.toLowerCase().trim(), value: v.value }));
  const res = await fetchWithTimeout(`${baseUrl}/api/leads/${leadId}`, {
    method: "PATCH", headers: buildHeaders(token), body: JSON.stringify({ custom_variables: cv }), timeoutMs: 20_000,
  });
  return res.ok;
}

// ── Campaign clone / details (used by nurture campaign-expansion) ───────────

/** Full campaign object from GET /api/campaigns/{id} — includes the fields
 *  listCampaigns omits (completion_percentage, total_leads_contacted, settings). */
export interface CampaignDetails {
  id: number;
  uuid?: string | null;
  name: string;
  type: string;
  status: string;
  completion_percentage?: number;
  total_leads?: number;
  total_leads_contacted?: number;
  max_emails_per_day?: number;
  max_new_leads_per_day?: number;
  plain_text?: boolean;
  open_tracking?: boolean;
  can_unsubscribe?: boolean;
  sequence_prioritization?: string;
}

export async function getCampaignDetails(instanceKey: string, campaignId: number): Promise<CampaignDetails | null> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/campaigns/${campaignId}`, { headers: buildHeaders(token) });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const d = (body?.data ?? body) as CampaignDetails | undefined;
  return d && typeof d.id === "number" ? d : null;
}

/** Duplicate a campaign (POST /api/campaigns/{id}/duplicate, no body). Bison
 *  copies the campaign + sequence/settings; the clone comes back as "Draft"
 *  named "Copy of …". Returns the new campaign or null on failure. */
export async function duplicateCampaign(instanceKey: string, campaignId: number): Promise<CampaignDetails | null> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/campaigns/${campaignId}/duplicate`, {
    method: "POST", headers: buildHeaders(token), timeoutMs: 45_000,
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const d = (body?.data ?? body) as CampaignDetails | undefined;
  return d && typeof d.id === "number" ? d : null;
}

/** Update a campaign's settings/name (PATCH /api/campaigns/{id}/update). */
export async function updateCampaign(
  instanceKey: string,
  campaignId: number,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/campaigns/${campaignId}/update`, {
    method: "PATCH", headers: buildHeaders(token), body: JSON.stringify(fields), timeoutMs: 30_000,
  });
  return res.ok;
}

// ── Verification / fallback helpers (read what duplicate carried) ───────────

export async function getCampaignSchedule(instanceKey: string, campaignId: number): Promise<Record<string, unknown> | null> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/campaigns/${campaignId}/schedule`, { headers: buildHeaders(token) });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return (body?.data ?? body) ?? null;
}

export async function createCampaignSchedule(instanceKey: string, campaignId: number, schedule: Record<string, unknown>): Promise<boolean> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/campaigns/${campaignId}/schedule`, {
    method: "POST", headers: buildHeaders(token), body: JSON.stringify(schedule), timeoutMs: 30_000,
  });
  return res.ok;
}

export interface CampaignSenderInbox { id: number; email: string; type: string; status: string; tags: string[] }

/**
 * The inbox pool returned by GET /api/campaigns/{id}/sender-emails.
 *
 * NOTE: this endpoint returns the client(tag)-scoped inbox POOL available to
 * the campaign — NOT the inboxes attached to that one campaign (a 0-lead draft
 * and an active campaign in the same tag group return the identical list, mixed
 * ESP types). Treat the result as "the inboxes carrying this campaign's client
 * tag", to be split by ESP before attaching. 15/page, paginated with a small
 * 429 backoff (the token is shared with live automations).
 */
export async function getCampaignSenderEmails(instanceKey: string, campaignId: number): Promise<CampaignSenderInbox[]> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const headers = buildHeaders(token);
  const MAX_PAGES = 600;     // 600 × 15 = 9,000 inboxes ceiling
  const CONCURRENCY = 8;     // parallelise the page sweep — 15/page is tiny, latency dominates
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  type Row = { id?: number; email?: string; type?: string; status?: string; tags?: Array<{ name?: string }> };
  async function fetchPage(page: number): Promise<{ rows: Row[]; lastPage: number }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetchWithTimeout(
        `${baseUrl}/api/campaigns/${campaignId}/sender-emails?page=${page}`,
        { headers, timeoutMs: 20_000 },
      );
      if (res.status === 429) { await sleep(1200 * (attempt + 1)); continue; } // shared-token throttle
      if (!res.ok) return { rows: [], lastPage: page };
      const body = await res.json().catch(() => null);
      return { rows: (body?.data ?? []) as Row[], lastPage: Number(body?.meta?.last_page) || page };
    }
    return { rows: [], lastPage: page };
  }

  const out: CampaignSenderInbox[] = [];
  const seen = new Set<number>();
  const collect = (rows: Row[]) => {
    for (const r of rows) {
      if (typeof r.id === "number" && !seen.has(r.id)) {
        seen.add(r.id);
        out.push({ id: r.id, email: String(r.email ?? ""), type: String(r.type ?? ""), status: String(r.status ?? ""), tags: (r.tags ?? []).map((t) => String(t?.name ?? "")) });
      }
    }
  };

  // Page 1 tells us how many pages there are; fetch the rest concurrently.
  const first = await fetchPage(1);
  collect(first.rows);
  const lastPage = Math.min(first.lastPage, MAX_PAGES);
  if (lastPage > 1) {
    let next = 2;
    const worker = async () => { while (next <= lastPage) { const p = next++; collect((await fetchPage(p)).rows); } };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, lastPage - 1) }, worker));
  }
  return out;
}

/** Classify a Bison inbox to its ESP bucket from its connection type + tags. */
export function inboxEsp(inbox: { type?: string; tags?: string[] }): "outlook" | "google" | "segs" {
  const type = (inbox.type || "").toLowerCase();
  const tags = (inbox.tags || []).map((t) => t.toLowerCase());
  if (type.includes("microsoft") || type.includes("outlook") || tags.includes("outlook")) return "outlook";
  if (type.includes("google") || type.includes("gmail") || tags.includes("google") || tags.includes("gmail")) return "google";
  return "segs"; // smtp / custom mail server / anything else
}

export interface AttachSendersResult { ok: boolean; added: boolean; alreadyPresent: boolean; message?: string }

/**
 * Attach inboxes to a campaign. Bison quirk: it returns HTTP 200 even when the
 * inboxes are ALREADY on the campaign — with body
 * {data:{success:false,message:"These emails already exist on this campaign…"}}.
 * So we parse the body: success:false + "already exist" ⇒ alreadyPresent (not an
 * error, nothing added); any other success:false ⇒ a real failure.
 */
export async function attachSenderEmails(instanceKey: string, campaignId: number, senderEmailIds: number[]): Promise<AttachSendersResult> {
  if (!senderEmailIds.length) return { ok: true, added: false, alreadyPresent: false };
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/campaigns/${campaignId}/attach-sender-emails`, {
    method: "POST", headers: buildHeaders(token), body: JSON.stringify({ sender_email_ids: senderEmailIds }), timeoutMs: 30_000,
  });
  const body = await res.json().catch(() => null);
  const message = body?.data?.message as string | undefined;
  if (!res.ok) return { ok: false, added: false, alreadyPresent: false, message: message || `HTTP ${res.status}` };
  if (body?.data?.success === false) {
    if (message && /already exist/i.test(message)) return { ok: true, added: false, alreadyPresent: true, message };
    return { ok: false, added: false, alreadyPresent: false, message }; // genuine failure
  }
  return { ok: true, added: true, alreadyPresent: false, message };
}

export async function getSequenceSteps(instanceKey: string, campaignId: number): Promise<unknown> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const res = await fetchWithTimeout(`${baseUrl}/api/campaigns/v1.1/${campaignId}/sequence-steps`, { headers: buildHeaders(token) });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.data ?? body ?? null;
}
