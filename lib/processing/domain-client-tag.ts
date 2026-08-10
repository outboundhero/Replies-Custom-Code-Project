/**
 * Domain → client-tag lookup for untracked replies.
 *
 * The deliverability dashboard (google-sheets-dashboard-nine — same app + token
 * as the tracked-sheets registry) maps each client's SENDING domain to the client
 * tag it belongs to. For an untracked reply we know the sending domain (the
 * client inbox that received the reply), so we can look up the tag directly
 * instead of following the sending domain's HTTP redirect to a website and
 * regex-matching it (see lib/processing/company-code-resolver.ts).
 *
 * GET /api/external/domain-client-tag?domain=<domain>
 *   Auth: Authorization: Bearer <token>
 *   The endpoint normalizes the domain (strips https://, www., paths, lowercases).
 *   → { domain, clientTag, clientTags, instances, allTags, found }
 *
 * Cached in-process per domain for 10 minutes. Any failure (network, timeout,
 * non-200) resolves to "not found" so the caller falls back to the old resolver
 * — a lookup miss must never drop a reply.
 */

const API_URL =
  process.env.GOOGLE_SHEETS_REGISTRY_URL_DOMAIN ||
  "https://google-sheets-dashboard-nine.vercel.app/api/external/domain-client-tag";
const API_TOKEN = process.env.GOOGLE_SHEETS_REGISTRY_TOKEN || "outboundhero2024";
const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 4000;

export interface DomainTagResult {
  clientTag: string | null; // primary tag, or null if the domain carries none
  found: boolean;           // true when the domain exists in the deliverability data
}

const cache = new Map<string, { data: DomainTagResult; ts: number }>();

/**
 * Look up the client tag for a sending domain. Returns { clientTag: null,
 * found: false } for unknown domains OR on any error (caller falls back).
 */
export async function lookupClientTagByDomain(domain: string): Promise<DomainTagResult> {
  const key = (domain || "").trim().toLowerCase();
  if (!key) return { clientTag: null, found: false };

  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < TTL_MS) return hit.data;

  let result: DomainTagResult = { clientTag: null, found: false };
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${API_URL}?domain=${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const json = (await res.json()) as { clientTag?: string | null; found?: boolean };
      const tag = typeof json?.clientTag === "string" ? json.clientTag.trim() : "";
      result = { clientTag: tag || null, found: !!json?.found };
    }
  } catch {
    // network/timeout/parse — leave result as "not found" so the caller falls back
  }

  cache.set(key, { data: result, ts: now });
  return result;
}
