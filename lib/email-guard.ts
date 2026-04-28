/**
 * EmailGuard host-lookup client.
 *
 * Returns the recipient mailbox provider for a given email address —
 * accurate even for custom B2B domains (does an MX lookup under the hood
 * and recognises Microsoft 365 / Google Workspace tenants).
 *
 * Docs: POST https://app.emailguard.io/api/v1/email-host-lookup
 *   Header: Authorization: Bearer <EMAILGUARD_API_KEY>
 *   Body:   { email: "user@example.com" }
 *   Result: { data: { email, email_host: "Gmail" | "Outlook" | "Office 365" | ... } }
 *
 * Set EMAILGUARD_API_KEY in .env.local (and in the Vercel project env).
 */

const EMAIL_GUARD_URL = "https://app.emailguard.io/api/v1/email-host-lookup";

export interface EmailGuardResult {
  email: string;
  email_host: string | null;
}

/**
 * Look up the email host for a single address.
 *
 * Returns the raw email_host string from EmailGuard ("Gmail", "Outlook",
 * "Office 365", "Yahoo", etc.) or null on lookup failure / missing key.
 * Never throws — callers can treat failures as "unknown ESP" and proceed.
 *
 * Retries up to 5 times on EVERY transient failure: HTTP 429, HTTP 5xx,
 * AND network-level errors (TypeError: fetch failed, ECONNRESET, etc.).
 * The previous version only retried on HTTP errors and returned null
 * immediately on connection drops — fine for a single webhook, fatal
 * across a multi-hour 378K-row backfill where local network blips
 * compounded into 85% loss.
 */
const RETRY_DELAYS_MS = [1500, 3000, 6000, 12000, 24000];

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response | null> {
  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt <= RETRY_DELAYS_MS.length) {
    try {
      const res = await fetch(url, init);
      // 429 / 5xx → retry. Other non-2xx → return so caller can decide.
      if (res.status === 429 || res.status >= 500) {
        if (attempt === RETRY_DELAYS_MS.length) return res;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        attempt++;
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt === RETRY_DELAYS_MS.length) {
        console.warn(`[email-guard] network error after ${RETRY_DELAYS_MS.length} retries:`, e);
        return null;
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      attempt++;
    }
  }
  console.warn(`[email-guard] retry loop fell through:`, lastErr);
  return null;
}

export async function lookupEmailHost(email: string): Promise<string | null> {
  const apiKey = process.env.EMAILGUARD_API_KEY;
  if (!apiKey) {
    console.warn("[email-guard] EMAILGUARD_API_KEY not set — skipping lookup");
    return null;
  }
  if (!email || !email.includes("@")) return null;

  const res = await fetchWithRetry(EMAIL_GUARD_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ email }),
  });
  if (!res) return null;
  if (!res.ok) {
    console.warn(`[email-guard] ${email} → ${res.status}`);
    return null;
  }
  try {
    const data = await res.json();
    return (data?.data?.email_host as string | null) ?? null;
  } catch (e) {
    console.warn(`[email-guard] ${email} → JSON parse failed`, e);
    return null;
  }
}
