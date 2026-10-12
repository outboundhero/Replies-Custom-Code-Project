/**
 * LeadSync (the deliverability dashboard, google-sheets-dashboard-nine) —
 * the calls the onboarding checklist makes. LeadSync owns the domain reserve:
 * which domains are free, how many a tier gets, and the tag → redirect →
 * attach → whitelist run. Reply Router asks it instead of deciding itself, so
 * the two never disagree about which domains are taken.
 *
 * Same token as the other LeadSync feeds (tracked-sheets, domain-client-tag,
 * inboxing-upload). Only /api/external/* is callable from here.
 */
const BASE = (process.env.LEADSYNC_BASE_URL || "https://google-sheets-dashboard-nine.vercel.app").replace(/\/+$/, "");
const TOKEN = process.env.GOOGLE_SHEETS_REGISTRY_TOKEN || "outboundhero2024";

export interface AllocationSide {
  instance: string;
  label: string;
  side: "b2b" | "b2c";
  /** Domains the client's tier gets on this instance. */
  cap: number;
  alreadyTagged: number;
  need: number;
  /** Ready reserve domains on this instance (LeadSync's rules). */
  reserveAvailable: number;
  /** The domains that would be given, in order. */
  picking: string[];
  short: number;
  note: string | null;
}
export interface AllocationPlan {
  clientTag: string;
  group: 1 | 2;
  tier: "0.5" | "1" | "2";
  tierSource: string;
  generatedFor: string;
  instances: AllocationSide[];
}
export type AllocationPreview = { ok: true; plan: AllocationPlan } | { ok: false; status: number; error: string };

/**
 * What LeadSync WOULD allocate to a new client — a dry run, nothing changes.
 * `tier` is optional: left out, LeadSync uses the Client Tracker's tier.
 */
export async function previewOnboardingAllocation(clientTag: string, group: 1 | 2, tier?: "0.5" | "1" | "2"): Promise<AllocationPreview> {
  try {
    const res = await fetch(`${BASE}/api/external/onboarding-allocate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ clientTag, group, ...(tier ? { tier } : {}), dryRun: true }),
      cache: "no-store",
      signal: AbortSignal.timeout(110_000),
    });
    const j = (await res.json().catch(() => null)) as (AllocationPlan & { error?: string }) | null;
    if (!res.ok || !j || !Array.isArray(j.instances)) {
      return { ok: false, status: res.status, error: j?.error || (res.status === 404 ? "LeadSync doesn't have the onboarding endpoint yet." : `LeadSync answered ${res.status}`) };
    }
    return { ok: true, plan: j };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}
