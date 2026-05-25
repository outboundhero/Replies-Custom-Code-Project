/**
 * Server-side Bison instance helpers.
 *
 * Re-exports the browser-safe metadata from `bison-instances-shared.ts`
 * and adds:
 *   - `getInstanceConfig` — pairs base URL with the env-var token; throws
 *     if the env var is missing.
 *   - `resolveInstanceForClient` — looks up which instance a client tag
 *     belongs to via Supabase `client_instances`.
 *
 * Adding a fifth instance later:
 *   1. Add a new entry to BISON_INSTANCES (in bison-instances-shared.ts).
 *   2. Set BISON_<KEY>_TOKEN in .env.local + Vercel.
 *   3. Point that Bison's webhook at /api/webhook/{tracked,untracked}/<key>.
 *   No other code change needed.
 */

import db from "@/lib/db";
import {
  BISON_INSTANCES,
  DEFAULT_INSTANCE,
  coerceInstance,
  isValidInstance,
  type BisonInstanceKey,
} from "./bison-instances-shared";

export {
  BISON_INSTANCES,
  DEFAULT_INSTANCE,
  coerceInstance,
  isValidInstance,
  getInstanceBaseUrl,
  getInstanceLabel,
  type BisonInstanceKey,
} from "./bison-instances-shared";

/**
 * Returns { baseUrl, token } for the named instance. Throws if the key is
 * unknown or the token env var is missing — both are configuration bugs
 * the operator must fix, not something to silently swallow.
 */
export function getInstanceConfig(key: string): { key: BisonInstanceKey; baseUrl: string; token: string } {
  if (!isValidInstance(key)) throw new Error(`Unknown Bison instance: ${key}`);
  const cfg = BISON_INSTANCES.find((i) => i.key === key)!;
  const envName = `BISON_${key.toUpperCase()}_TOKEN`;
  const token = process.env[envName];
  if (!token) {
    throw new Error(`Missing env var ${envName} for Bison instance ${key}`);
  }
  return { key, baseUrl: cfg.baseUrl, token };
}

/**
 * Per-client → instance lookup. Backed by Turso `client_instances`
 * (client_tag PK, instance_key). Falls back to the default instance when:
 *   - no clientTag is provided
 *   - no row exists yet (so newly-onboarded clients work without a row)
 *   - the stored key is invalid (e.g. an instance was retired)
 *   - the table doesn't exist yet (pre-migration deploy is safe)
 *
 * Memoised in-process for a short TTL so the lookup is cheap for callers
 * that resolve the same client tag many times in a single request.
 */
const CACHE_TTL_MS = 60 * 1000;
const clientCache = new Map<string, { key: BisonInstanceKey; ts: number }>();

export async function resolveInstanceForClient(clientTag: string | null | undefined): Promise<BisonInstanceKey> {
  if (!clientTag) return DEFAULT_INSTANCE;
  const now = Date.now();
  const cached = clientCache.get(clientTag);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.key;

  let resolved: BisonInstanceKey = DEFAULT_INSTANCE;
  try {
    const result = await db.execute({
      sql: "SELECT instance_key FROM client_instances WHERE client_tag = ?",
      args: [clientTag],
    });
    const row = result.rows[0];
    if (row) resolved = coerceInstance(row.instance_key as string);
  } catch {
    // Table may not exist yet on a fresh deployment — default instance is safe.
  }
  clientCache.set(clientTag, { key: resolved, ts: now });
  return resolved;
}

/** Invalidate the in-process cache (call after an admin write). */
export function invalidateInstanceCache(clientTag?: string) {
  if (clientTag) clientCache.delete(clientTag);
  else clientCache.clear();
}
