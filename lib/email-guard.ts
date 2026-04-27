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
 */
export async function lookupEmailHost(email: string): Promise<string | null> {
  const apiKey = process.env.EMAILGUARD_API_KEY;
  if (!apiKey) {
    console.warn("[email-guard] EMAILGUARD_API_KEY not set — skipping lookup");
    return null;
  }
  if (!email || !email.includes("@")) return null;

  try {
    const res = await fetch(EMAIL_GUARD_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      // 429 (rate limit) and 5xx warrant a quick retry; everything else is fatal-soft.
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500));
        const retry = await fetch(EMAIL_GUARD_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ email }),
        });
        if (!retry.ok) {
          console.warn(`[email-guard] ${email} → ${retry.status} after retry`);
          return null;
        }
        const data = await retry.json();
        return (data?.data?.email_host as string | null) ?? null;
      }
      console.warn(`[email-guard] ${email} → ${res.status}`);
      return null;
    }
    const data = await res.json();
    return (data?.data?.email_host as string | null) ?? null;
  } catch (e) {
    console.warn(`[email-guard] ${email} → threw`, e);
    return null;
  }
}
