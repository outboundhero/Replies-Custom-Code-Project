/**
 * Push a categorized lead to a client's GoHighLevel (GHL) sub-account.
 *
 * Fires when a lead is marked with one of GHL_PUSH_CATEGORIES in the Reply Router
 * (app/api/inbox/mutate.ts → update-category), mirroring the pushToSheet hook.
 * Only clients with GHL creds in Turso `client_config` (ghl_api_key +
 * ghl_location_id) push — everyone else is a no-op.
 *
 * Uses the GHL v2 upsert endpoint, which dedupes on the location's primary
 * contact field (set Email as primary in GHL), so re-marking a lead UPDATES the
 * existing contact instead of creating a duplicate.
 */
import db from "@/lib/db";
import { findLeadByEmail } from "@/lib/outboundhero-api";

/** Lead Category values that trigger a GHL push (exact `lead_category` strings). */
export const GHL_PUSH_CATEGORIES = [
  "Interested",
  "Meeting-Ready Lead",
  "Follow Up",
  "Referral Given",
  "Not Interested",
  "Not Interested (Send Reply)",
] as const;

export function isGhlPushCategory(category: string | null | undefined): boolean {
  if (!category) return false;
  return GHL_PUSH_CATEGORIES.some((c) => c.toLowerCase() === category.toLowerCase());
}

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with a hard timeout + retry on 429 / 5xx (mirrors lib/outboundhero-api.ts). */
async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 20_000, ...rest } = init;
  const MAX_RETRIES = 4;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { ...rest, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(t);
      if (attempt >= 2) throw e;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    clearTimeout(t);
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 800 * 2 ** attempt);
      continue;
    }
    return res;
  }
}

/**
 * Best-effort E.164 normalization. US-centric (these clients are US cleaning
 * companies): 10 digits → +1XXXXXXXXXX, 11 starting with 1 → +1…, already-`+`
 * kept if it looks valid. Anything we can't confidently format returns null so
 * the contact is still created WITHOUT a phone (never block on a bad number).
 */
export function normalizePhoneE164(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null; // ambiguous length without a country code → omit
}

// Custom-variable names that may hold a phone, highest-priority first.
const PHONE_VAR_PRIORITY = [
  "company phone", "phone", "phone number", "mobile", "mobile phone",
  "cell", "cell phone", "telephone", "direct phone", "work phone", "contact phone",
];

/**
 * Pull the first VALID (E.164-able) phone out of a Bison lead's custom_variables.
 * Tries known phone var names in priority order, then any var whose name mentions
 * phone/mobile/cell/tel. Returns null if none normalize (→ push without phone).
 */
export function pickPhoneFromCustomVars(vars?: Array<{ name?: string; value?: string }>): string | null {
  if (!vars || !vars.length) return null;
  for (const key of PHONE_VAR_PRIORITY) {
    const hit = vars.find((v) => (v?.name || "").toLowerCase().trim() === key);
    const p = hit ? normalizePhoneE164(hit.value) : null;
    if (p) return p;
  }
  for (const v of vars) {
    if (/phone|mobile|cell|tel/i.test(v?.name || "")) {
      const p = normalizePhoneE164(v.value);
      if (p) return p;
    }
  }
  return null;
}

export interface GhlConfig { apiKey: string; locationId: string }

/** Per-client GHL creds from Turso, or null if not configured (→ no push). */
export async function getGhlConfig(clientTag: string): Promise<GhlConfig | null> {
  try {
    const res = await db.execute({
      sql: "SELECT ghl_api_key, ghl_location_id FROM client_config WHERE UPPER(client_tag) = UPPER(?)",
      args: [clientTag],
    });
    const row = res.rows[0];
    if (!row) return null;
    const apiKey = ((row.ghl_api_key as string) || "").trim();
    const locationId = ((row.ghl_location_id as string) || "").trim();
    if (!apiKey || !locationId) return null;
    return { apiKey, locationId };
  } catch {
    return null; // columns not migrated yet
  }
}

export interface GhlLead {
  lead_email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  lead_name?: string | null;
  company_name?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  lead_category?: string | null;
  /** Bison instance — lets us re-resolve phone from the lead's custom variables
   *  when the stored `phone` is missing/invalid. */
  bison_instance?: string | null;
}

export interface GhlPushResult { ok: boolean; status?: number; created?: boolean; error?: string }

/**
 * Upsert one lead into the client's GHL sub-account. Returns ok:false (without
 * throwing) when the client isn't configured or the lead has no email — callers
 * treat that as a skip, not a failure.
 */
export async function pushToGhl(clientTag: string, lead: GhlLead): Promise<GhlPushResult> {
  const cfg = await getGhlConfig(clientTag);
  if (!cfg) return { ok: false, error: `no GHL config for ${clientTag}` };

  const email = (lead.lead_email || "").trim();
  if (!email) return { ok: false, error: "lead has no email" };

  let firstName = (lead.first_name || "").trim();
  let lastName = (lead.last_name || "").trim();
  if (!firstName && !lastName && lead.lead_name) {
    const parts = lead.lead_name.trim().split(/\s+/);
    firstName = parts[0] || "";
    lastName = parts.slice(1).join(" ");
  }

  const tags = ["OutboundHero"];
  if (lead.lead_category) tags.unshift(lead.lead_category);

  const body: Record<string, unknown> = {
    locationId: cfg.locationId,
    email,
    source: "OutboundHero",
    tags,
  };
  if (firstName) body.firstName = firstName;
  if (lastName) body.lastName = lastName;

  // Phone: prefer the stored value; if it's missing/invalid (e.g. junk like
  // "there"), scan the Bison lead's custom variables for a real phone. Only omit
  // when nothing valid is found anywhere.
  let phone = normalizePhoneE164(lead.phone);
  if (!phone && lead.bison_instance) {
    try {
      const bisonLead = await findLeadByEmail(lead.bison_instance, email);
      phone = pickPhoneFromCustomVars(bisonLead?.custom_variables);
    } catch { /* leave phone null — push without it */ }
  }
  if (phone) body.phone = phone;
  if (lead.company_name) body.companyName = lead.company_name;
  if (lead.address) body.address1 = lead.address;
  if (lead.city) body.city = lead.city;
  if (lead.state) body.state = lead.state;

  try {
    const res = await fetchWithTimeout(`${GHL_BASE}/contacts/upsert`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        Version: GHL_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      timeoutMs: 20_000,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: `HTTP ${res.status}: ${txt.slice(0, 300)}` };
    }
    const data = await res.json().catch(() => null);
    return { ok: true, status: res.status, created: data?.new === true || res.status === 201 };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
