/**
 * Browser-safe Bison instance metadata.
 *
 * This file deliberately has NO server-only imports (no supabase, no
 * env-var reads) so it can be pulled into client components for things
 * like building dashboard URLs without bloating the bundle.
 *
 * Server code that needs tokens or the client→instance lookup should
 * import from `@/lib/bison-instances` instead, which re-exports
 * everything here plus the server-only helpers.
 */

export const BISON_INSTANCES = [
  { key: "outboundhero",     label: "OutboundHero",      baseUrl: "https://app.outboundhero.co" },
  { key: "outboundclean",    label: "Outbound Clean",    baseUrl: "https://personal.outboundclean.com" },
  { key: "cleaningoutbound", label: "Cleaning Outbound", baseUrl: "https://personal.cleaningoutbound.com" },
  { key: "facilityreach",    label: "Facility Reach",    baseUrl: "https://app.facilityreach.com" },
] as const;

export type BisonInstanceKey = typeof BISON_INSTANCES[number]["key"];

/** The instance everything defaults to when no mapping exists. */
export const DEFAULT_INSTANCE: BisonInstanceKey = "outboundhero";

const INSTANCE_KEYS = new Set<string>(BISON_INSTANCES.map((i) => i.key));

export function isValidInstance(key: string | null | undefined): key is BisonInstanceKey {
  return typeof key === "string" && INSTANCE_KEYS.has(key);
}

/** Coerce any string to a valid instance key, falling back to the default. */
export function coerceInstance(key: string | null | undefined): BisonInstanceKey {
  return isValidInstance(key) ? key : DEFAULT_INSTANCE;
}

export function getInstanceLabel(key: string): string {
  const cfg = BISON_INSTANCES.find((i) => i.key === key);
  return cfg?.label ?? key;
}

export function getInstanceBaseUrl(key: string): string {
  const cfg = BISON_INSTANCES.find((i) => i.key === key);
  return cfg?.baseUrl ?? BISON_INSTANCES[0].baseUrl;
}
