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
import { getCached, setCached } from "@/lib/server-cache";

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
 *
 * The plan is a heavy read on LeadSync's side (it walks every domain, ~10s),
 * so a good answer is kept for 5 minutes — reopening the preview doesn't ask
 * again. Failures are never kept.
 */
export async function previewOnboardingAllocation(clientTag: string, group: 1 | 2, tier?: "0.5" | "1" | "2"): Promise<AllocationPreview> {
  const key = `leadsync:allocation:${clientTag}:${group}:${tier ?? "tracker"}`;
  const kept = getCached<AllocationPlan>(key, 5 * 60_000);
  if (kept) return { ok: true, plan: kept };
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
      const raw = j?.error || (res.status === 404 ? "LeadSync doesn't have the onboarding endpoint yet." : `LeadSync answered ${res.status}`);
      // Its database cancels a read that runs too long while it is busy.
      const error = /statement timeout/i.test(raw) ? "LeadSync's database was busy and gave up on the read — try again in a minute." : raw;
      return { ok: false, status: res.status, error };
    }
    setCached(key, j);
    return { ok: true, plan: j };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}
