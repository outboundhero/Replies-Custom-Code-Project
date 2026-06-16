/**
 * Client GROUP → Bison instance routing.
 *
 * Each client is Group 1 or Group 2 (synced from the instance-mapping sheet into
 * the Turso `client_groups` table by /api/cron/sync-client-groups). A nurture
 * lead routes to its group's B2B instance (business-domain email) or B2C
 * instance (personal email — isPersonalDomain), then to the ESP campaign there.
 *
 *   Group 1 → B2B #1 outboundhero   | B2C #1 cleaningoutbound
 *   Group 2 → B2B #2 facilityreach  | B2C #2 outboundclean
 */
import db from "@/lib/db";
import type { BisonInstanceKey } from "@/lib/bison-instances-shared";
import { isPersonalDomain } from "@/lib/processing/personal-domains";

export const GROUP_INSTANCE_MAP: Record<1 | 2, { b2b: BisonInstanceKey; b2c: BisonInstanceKey }> = {
  1: { b2b: "outboundhero", b2c: "cleaningoutbound" },
  2: { b2b: "facilityreach", b2c: "outboundclean" },
};

export interface ClientInstances {
  group: 1 | 2;
  b2b: BisonInstanceKey;
  b2c: BisonInstanceKey;
}

let cache: { map: Map<string, 1 | 2>; ts: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

async function loadGroups(): Promise<Map<string, 1 | 2>> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.map;
  const map = new Map<string, 1 | 2>();
  try {
    const res = await db.execute("SELECT client_tag, group_num FROM client_groups");
    for (const r of res.rows) {
      const g = Number(r.group_num);
      if (g === 1 || g === 2) map.set(String(r.client_tag).toUpperCase(), g);
    }
  } catch {
    // table not created yet → empty
  }
  cache = { map, ts: Date.now() };
  return map;
}

export function invalidateGroupCache() { cache = null; }

/** This client's group + its B2B/B2C instances, or null if unmapped. */
export async function getClientInstances(tag: string | null | undefined): Promise<ClientInstances | null> {
  if (!tag) return null;
  const g = (await loadGroups()).get(tag.toUpperCase());
  if (!g) return null;
  return { group: g, ...GROUP_INSTANCE_MAP[g] };
}

/** Batch form for dashboards — one SELECT, no per-tag round-trips. */
export async function getAllClientInstances(): Promise<Map<string, ClientInstances>> {
  const groups = await loadGroups();
  const out = new Map<string, ClientInstances>();
  for (const [tag, g] of groups) out.set(tag, { group: g, ...GROUP_INSTANCE_MAP[g] });
  return out;
}

/** Resolve where a single lead should be nurtured: the client's group's B2B
 *  instance for business emails, B2C instance for personal emails. null when
 *  the client has no group mapping (caller should skip — never default-route). */
export async function targetInstanceForLead(
  tag: string,
  email: string,
): Promise<{ instance: BisonInstanceKey; lane: "b2b" | "b2c" } | null> {
  const inst = await getClientInstances(tag);
  if (!inst) return null;
  const lane = isPersonalDomain(email) ? "b2c" : "b2b";
  return { instance: inst[lane], lane };
}
