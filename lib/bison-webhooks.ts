/**
 * Bison (EmailBison) webhook-observability helpers.
 *
 * Backs the Webhook Activity dashboard. Bison exposes webhook health via
 * GET /api/events (the last ~10 days of events, each carrying its
 * webhook_deliveries[] → webhook_attempts[]) and a
 * POST /api/webhook-attempts/{id}/retry to replay a delivery.
 *
 * We fetch events per instance with CURSOR pagination (the only mode this
 * route supports — see docs.emailbison.com/get-started/pagination), bound the
 * window to the last N days via start_date, and FLATTEN each event's
 * deliveries into a single time-ordered list the UI can render + retry.
 *
 * Every function is instance-aware — the token/baseUrl come from
 * getInstanceConfig(key) (env BISON_<KEY>_TOKEN), same as lib/outboundhero-api.
 */

import { getInstanceConfig } from "@/lib/bison-instances";

// ── raw Bison shapes (minimal — only the fields we read) ─────────────────────

interface RawAttempt {
  id?: number;
  status?: string;
  response_code?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}
interface RawDelivery {
  id?: number;
  event_id?: number;
  webhook_url?: string;
  attempt_count?: number;
  last_attempt_at?: string | null;
  status?: string;
  webhook_attempts?: RawAttempt[];
  created_at?: string | null;
}
interface RawEvent {
  id?: number;
  uuid?: string;
  payload?: {
    event?: { type?: string; name?: string; workspace_name?: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data?: any;
  };
  webhook_deliveries?: RawDelivery[];
  created_at?: string | null;
}
interface RawEventsResponse {
  data?: RawEvent[];
  meta?: { next_cursor?: string | null; prev_cursor?: string | null };
}

// ── public shapes ────────────────────────────────────────────────────────────

export type DeliveryStatus = "succeeded" | "failed" | "pending" | "unknown";

export interface WebhookAttempt {
  id: number;
  status: DeliveryStatus;
  responseCode: number | null;
  at: string | null;
}

export interface WebhookDeliveryItem {
  instance: string;
  deliveryId: number;
  eventId: number;
  eventType: string; // machine, e.g. "LEAD_REPLIED"
  eventName: string; // human, e.g. "Contact Replied"
  webhookUrl: string;
  status: DeliveryStatus;
  attemptCount: number;
  latestResponseCode: number | null;
  latestAttemptId: number | null; // what the Retry button acts on
  attempts: WebhookAttempt[];
  at: string | null; // last_attempt_at || created_at — the row's timestamp
  contact: string | null; // best-effort lead / from email for context
  subject: string | null; // best-effort reply subject / label
}

export interface WebhookActivityPage {
  items: WebhookDeliveryItem[];
  nextCursor: string | null;
  scannedEvents: number; // how many events we paged through this request
}

function normStatus(s: string | undefined): DeliveryStatus {
  const v = (s || "").toLowerCase();
  if (v === "succeeded" || v === "success") return "succeeded";
  if (v === "failed" || v === "failure") return "failed";
  if (v === "pending" || v === "processing" || v === "queued") return "pending";
  return "unknown";
}

// ── fetch with timeout + light 429/503 backoff (mirrors outboundhero-api) ─────

async function bisonGet(url: string, token: string, timeoutMs = 25_000): Promise<Response> {
  const MAX = 4;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    } finally {
      clearTimeout(t);
    }
    if ((res.status === 429 || res.status === 503) && attempt < MAX) {
      const ra = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt));
      continue;
    }
    return res;
  }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Dig best-effort context out of the event payload so a row reads like
// "Contact Replied — jane@acme.com · Re: your quote" instead of a bare id.
function extractContext(ev: RawEvent): { contact: string | null; subject: string | null } {
  const data = ev.payload?.data;
  if (!data || typeof data !== "object") return { contact: null, subject: null };
  const reply = data.reply;
  const lead = data.lead;
  const sender = data.sender_email;
  const contact =
    reply?.from_email_address ||
    lead?.email ||
    sender?.email ||
    data.email ||
    null;
  const subject =
    reply?.email_subject ||
    lead?.company ||
    data.campaign?.name ||
    null;
  return { contact: contact ? String(contact) : null, subject: subject ? String(subject) : null };
}

/**
 * One page of flattened webhook deliveries for an instance, newest first.
 *
 * Because most events (email_sent, opened, …) carry no deliveries, we page
 * through several event pages per request and keep going until we've gathered
 * ~`target` deliveries, run out of events, or hit the page budget — so each
 * call returns a filled list instead of a mostly-empty one. `nextCursor` (when
 * present) resumes exactly where we stopped.
 */
export async function fetchWebhookActivity(
  instanceKey: string,
  opts: { cursor?: string | null; type?: string | null; onlyFailed?: boolean; sinceDays?: number; target?: number; maxPages?: number } = {}
): Promise<WebhookActivityPage> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const sinceDays = opts.sinceDays ?? 3;
  const target = opts.target ?? 40;
  const maxPages = opts.maxPages ?? 8;

  const start = new Date();
  start.setUTCDate(start.getUTCDate() - sinceDays);
  const startDate = ymd(start);
  // Bison validates start_date <= end_date and rejects start_date sent alone,
  // so we always send end_date too. Use tomorrow so all of today is included.
  const end = new Date();
  end.setUTCDate(end.getUTCDate() + 1);
  const endDate = ymd(end);

  const items: WebhookDeliveryItem[] = [];
  let cursor: string | null = opts.cursor ?? null;
  let scannedEvents = 0;
  let pages = 0;

  for (; pages < maxPages; pages++) {
    const qs = new URLSearchParams({ pagination_type: "cursor", per_page: "100", start_date: startDate, end_date: endDate });
    if (opts.type) qs.set("type", opts.type);
    if (cursor) qs.set("cursor", cursor);

    const res = await bisonGet(`${baseUrl}/api/events?${qs.toString()}`, token);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Bison events fetch failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const json = (await res.json()) as RawEventsResponse;
    const events = json.data ?? [];
    scannedEvents += events.length;

    for (const ev of events) {
      const deliveries = ev.webhook_deliveries ?? [];
      if (deliveries.length === 0) continue;
      const { contact, subject } = extractContext(ev);
      const eventType = ev.payload?.event?.type || "";
      const eventName = ev.payload?.event?.name || eventType || "Event";

      for (const d of deliveries) {
        const attempts: WebhookAttempt[] = (d.webhook_attempts ?? [])
          .map((a) => ({
            id: Number(a.id ?? 0),
            status: normStatus(a.status),
            responseCode: a.response_code ?? null,
            at: a.updated_at || a.created_at || null,
          }))
          .sort((x, y) => (y.at || "").localeCompare(x.at || "")); // newest first
        const status = normStatus(d.status);
        if (opts.onlyFailed && status !== "failed") continue;
        const latest = attempts[0] ?? null;
        items.push({
          instance: instanceKey,
          deliveryId: Number(d.id ?? 0),
          eventId: Number(d.event_id ?? ev.id ?? 0),
          eventType,
          eventName,
          webhookUrl: d.webhook_url || "",
          status,
          attemptCount: d.attempt_count ?? attempts.length,
          latestResponseCode: latest?.responseCode ?? null,
          latestAttemptId: latest?.id ?? null,
          attempts,
          at: d.last_attempt_at || d.created_at || ev.created_at || null,
          contact,
          subject,
        });
      }
    }

    cursor = json.meta?.next_cursor ?? null;
    if (!cursor) break; // reached the end of the window
    if (items.length >= target) break; // filled this page
  }

  // Newest first across everything we gathered.
  items.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  return { items, nextCursor: cursor, scannedEvents };
}

/**
 * Replay a single webhook attempt (Bison re-sends the event to the listener
 * URL, creating a fresh delivery). Returns Bison's ack + the new delivery id.
 */
export async function retryWebhookAttempt(
  instanceKey: string,
  attemptId: number
): Promise<{ success: boolean; message: string; webhookDeliveryId: number | null }> {
  const { baseUrl, token } = getInstanceConfig(instanceKey);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${baseUrl}/api/webhook-attempts/${attemptId}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Retry failed (${res.status}): ${JSON.stringify(raw).slice(0, 200)}`);
    }
    const data = (raw as { data?: { success?: boolean; message?: string; webhook_delivery_id?: number } }).data ?? {};
    return {
      success: data.success ?? true,
      message: data.message ?? "Retry queued.",
      webhookDeliveryId: data.webhook_delivery_id ?? null,
    };
  } finally {
    clearTimeout(t);
  }
}
