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
// Anything that makes LeadSync WRITE (allocate a batch, send an email) needs a
// second secret that only the two apps hold. No fallback: without it LeadSync
// refuses, and the steps here stay previews.
const RUN_SECRET = (process.env.LEADSYNC_RUN_SECRET || "").trim();
/** Whether this server can ask LeadSync to run anything at all. */
export const leadsyncRunSecretSet = () => RUN_SECRET.length >= 24;
const runHeaders = () => ({
  Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json",
  ...(RUN_SECRET ? { "X-Onboarding-Run-Secret": RUN_SECRET } : {}),
});

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
  /** Candidates left out because they already carry another client's tag. */
  setAside?: number;
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
  /** The group LeadSync's allocation sheet has this tag in (null = not there yet). */
  allocationGroup?: 1 | 2 | null;
  groupMismatch?: boolean;
  /** The website LeadSync has for the client (Client Tracker) — the redirect it will use. null = it has none. */
  knownRedirect?: string | null;
  /** Why LeadSync would refuse a run right now (not in the tracker, no website, no sheet, group…). */
  runBlockers?: string[];
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
export async function previewOnboardingAllocation(clientTag: string, group: 1 | 2, tier?: "0.5" | "1" | "2", fresh = false): Promise<AllocationPreview> {
  const key = planKey(clientTag, group, tier);
  // `fresh` skips a plan kept from the last few minutes. A plan LeadSync says it
  // wouldn't run is only kept briefly: whoever is fixing the reason (a missing
  // website, a missing sheet) should see it clear without a five-minute wait.
  let kept = fresh ? null : getCached<AllocationPlan>(key, 5 * 60_000);
  if (kept?.runBlockers?.length) kept = getCached<AllocationPlan>(key, 45_000);
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

const planKey = (clientTag: string, group: 1 | 2, tier?: "0.5" | "1" | "2") => `leadsync:allocation:${clientTag}:${group}:${tier ?? "tracker"}`;

/**
 * Keep the plan as it stands after a batch (or drop it, with null), so the
 * next batch doesn't ask LeadSync for a whole new plan — each plan is a heavy
 * read on its side, and it re-checks every batch itself anyway.
 */
export function rememberAllocationPlan(clientTag: string, group: 1 | 2, tier: "0.5" | "1" | "2" | undefined, plan: AllocationPlan | null): void {
  setCached(planKey(clientTag, group, tier), plan);
}

export interface AllocationRunResult {
  ok: boolean;
  instance: string;
  added: number;
  steps: { label: string; state: string; note?: string }[];
  limit: { updated?: number; failed?: number; total?: number; error?: string };
  /** What LeadSync itself found wrong after the batch, when it checks (newer LeadSync). */
  problems?: string[];
}
export type AllocationRun = { ok: true; result: AllocationRunResult } | { ok: false; status: number; error: string };

/**
 * Have LeadSync allocate ONE batch (at most 5 domains) on one instance: tag →
 * redirect → attach to the campaigns → client sheet → whitelist queue → daily
 * limit. LeadSync re-checks everything on its side and refuses unless its own
 * switch is on. One attempt — a repeat is the caller's decision.
 */
export async function runOnboardingAllocation(input: {
  clientTag: string; group: 1 | 2; tier?: "0.5" | "1" | "2"; instance: string;
  domains: string[]; redirectUrl: string; campaignIds: number[]; dailyLimit: number;
}): Promise<AllocationRun> {
  try {
    const res = await fetch(`${BASE}/api/external/onboarding-allocate`, {
      method: "POST",
      headers: runHeaders(),
      body: JSON.stringify({ ...input, dryRun: false }),
      cache: "no-store",
      signal: AbortSignal.timeout(285_000),
    });
    const j = (await res.json().catch(() => null)) as (AllocationRunResult & { error?: string }) | null;
    if (!res.ok || !j || !Array.isArray(j.steps)) return { ok: false, status: res.status, error: j?.error || `LeadSync answered ${res.status}` };
    return { ok: true, result: j };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

// ── The whitelisting-domains email ──────────────────────────────────────────
// LeadSync writes and sends it (its 6:30 AM batch, its "send now"); the
// checklist asks it for the same email and, when switched on, to send it now.

export interface WhitelistPlan {
  clientTag: string;
  /** On LeadSync's no-whitelist-email list (e.g. an outside agency works the leads). */
  exempt: boolean;
  /** Whether LeadSync's email sender is set up at all. */
  webhookConfigured: boolean;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  /** Why the client can't be emailed (not in ReplyRouter, no contacts), or null. */
  recipientProblem: string | null;
  subject: string;
  /** The email body as it would be sent, listing `domains.toSend`. */
  text: string;
  domains: {
    assigned: number;
    /** Assigned domains this client hasn't been emailed about yet. */
    toSend: string[];
    /** The part of toSend already waiting for the 6:30 AM batch. */
    queued: string[];
    alreadySent: { domain: string; sentAt: string | null }[];
    burnt: string[];
    leaving: string[];
    noInboxes: string[];
  };
  queuedUnder: string[];
}
export type WhitelistPreview = { ok: true; plan: WhitelistPlan } | { ok: false; status: number; error: string };

/** The whitelist email LeadSync WOULD send this client — a dry run, nothing is sent. Always asked fresh (a light read). */
export async function previewOnboardingWhitelist(clientTag: string): Promise<WhitelistPreview> {
  try {
    const res = await fetch(`${BASE}/api/external/onboarding-whitelist`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ clientTag, dryRun: true }),
      cache: "no-store",
      signal: AbortSignal.timeout(55_000),
    });
    const j = (await res.json().catch(() => null)) as (WhitelistPlan & { error?: string }) | null;
    if (!res.ok || !j || !j.domains || !Array.isArray(j.domains.toSend)) {
      const raw = j?.error || (res.status === 404 ? "LeadSync doesn't have the whitelist endpoint yet." : `LeadSync answered ${res.status}`);
      const error = /statement timeout/i.test(raw) ? "LeadSync's database was busy and gave up on the read — try again in a minute." : raw;
      return { ok: false, status: res.status, error };
    }
    return { ok: true, plan: j };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

export interface WhitelistRunResult {
  ok: boolean;
  sentEmails: number;
  sentDomains: number;
  failures: { step: string; subTag: string; reason: string; domains: string[] }[];
}
export type WhitelistRun = { ok: true; result: WhitelistRunResult } | { ok: false; status: number; error: string };

/**
 * Have LeadSync send the whitelist email NOW for exactly these domains. It
 * re-checks on its side (each domain must still be the client's and not yet
 * sent) and refuses unless its own switch is on. One attempt — never retried
 * here, because a repeat could email the client twice.
 */
export async function runOnboardingWhitelist(clientTag: string, domains: string[]): Promise<WhitelistRun> {
  try {
    const res = await fetch(`${BASE}/api/external/onboarding-whitelist`, {
      method: "POST",
      headers: runHeaders(),
      body: JSON.stringify({ clientTag, domains, dryRun: false }),
      cache: "no-store",
      signal: AbortSignal.timeout(55_000),
    });
    const j = (await res.json().catch(() => null)) as (WhitelistRunResult & { error?: string }) | null;
    if (!j || typeof j.sentDomains !== "number" || !Array.isArray(j.failures)) {
      return { ok: false, status: res.status, error: j?.error || `LeadSync answered ${res.status}` };
    }
    // An answer that carries a result is kept even when the status isn't 200 —
    // the caller needs to see what went out.
    return { ok: true, result: res.ok ? j : { ...j, ok: false } };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}
