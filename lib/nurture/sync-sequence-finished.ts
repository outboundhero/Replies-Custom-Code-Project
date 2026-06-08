/**
 * Sync sequence-finished leads (Scenario 3) from EmailBison/OutboundHero.
 *
 * Strategy:
 * 1. For EVERY Bison instance in parallel (Promise.allSettled so one bad
 *    instance doesn't kill the others):
 *    a. Fetch ALL outbound campaigns (skip [Nurture] campaigns themselves).
 *    b. For each campaign, fetch leads with lead_campaign_status = "sequence_finished".
 *    c. Filter: keep only leads where overall_stats.replies === 0 (never replied) AND
 *       overall_stats.bounced != true (no bounce).
 *    d. Upsert into nurture_sequence_finished — sequence_finished_at = lead.updated_at,
 *       bison_instance = the instance the campaign came from.
 *
 * Eligibility = sequence_finished_at + 45 days, computed at query time.
 */

import supabase from "@/lib/supabase";
import { listCampaigns, listCampaignLeads, type OutboundLead } from "@/lib/outboundhero-api";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import { BISON_INSTANCES, type BisonInstanceKey } from "@/lib/bison-instances";

interface InstanceSyncResult {
  instance: BisonInstanceKey;
  campaignsScanned: number;
  candidatesFound: number;
  upserted: number;
  errors: string[];
}

export interface SyncResult {
  campaignsScanned: number;
  candidatesFound: number;
  upserted: number;
  errors: string[];
  /** Per-instance breakdown so the caller can spot one instance lagging. */
  perInstance: InstanceSyncResult[];
}

/** Bounded-concurrency worker pool: run `fn` over `items` with at most N
 *  in flight at any time. Returns when every item has been processed. */
async function parallelForEach<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (idx < items.length) {
        const my = idx++;
        try { await fn(items[my]); } catch { /* worker swallows; per-item errors logged inside fn */ }
      }
    }),
  );
}

export interface InstanceSyncState {
  campaignsScanned: number;
  candidatesFound: number;
  upserted: number;
  errors: string[];
}

/** Public wrapper for per-instance cron routes — handles state init + timeout. */
export async function syncOneInstanceExported(instanceKey: BisonInstanceKey): Promise<InstanceSyncResult> {
  const state: InstanceSyncState = { campaignsScanned: 0, candidatesFound: 0, upserted: 0, errors: [] };
  return withTimeout(
    syncOneInstance(instanceKey, state),
    INSTANCE_TIMEOUT_MS,
    `instance ${instanceKey}`,
    () => ({ instance: instanceKey, ...state, errors: [...state.errors, `[${instanceKey}] timed out after ${INSTANCE_TIMEOUT_MS / 1000}s — partial progress shown`] }),
  );
}

async function syncOneInstance(instanceKey: BisonInstanceKey, state: InstanceSyncState): Promise<InstanceSyncResult> {
  // `state` is owned by the caller so withTimeout can snapshot live
  // counts if the timer fires before the function returns.
  const errors = state.errors;

  // Server-side status filter — Bison returns ONLY these statuses, so
  // we never page through drafts / archived / failed. On outboundhero
  // this drops 1,136 total campaigns to ~477 actually-worth-syncing.
  const allCampaigns = await listCampaigns(instanceKey, {
    statuses: ["active", "completed", "paused", "stopped"],
  });

  // Client-side filter for the remaining bits Bison can't filter for us.
  const outboundCampaigns = allCampaigns.filter((c) => {
    const name = c.name?.toLowerCase() || "";
    if (name.includes("[nurture]") || c.type === "nurture") return false;
    const total = c.total_leads ?? 0;
    if (total === 0) return false;
    const exhausted = (c.replied ?? 0) + (c.bounced ?? 0);
    if (exhausted >= total) return false;
    return true;
  });

  // Sort by oldest-synced first so the rate-limited slice each run
  // covers campaigns that haven't been touched recently. Without this,
  // outboundhero's 477 campaigns get processed in Bison's default order
  // every tick — small/early campaigns hog every run and bottom-of-list
  // clients (like JPH) never get reached before the rate limit fires.
  const { data: lastSynced } = await supabase
    .from("nurture_sequence_finished")
    .select("ob_campaign_id, synced_at")
    .eq("bison_instance", instanceKey)
    .order("synced_at", { ascending: false });
  const lastSyncedByCampaign = new Map<number, string>();
  for (const r of lastSynced || []) {
    const id = r.ob_campaign_id as number;
    if (!lastSyncedByCampaign.has(id)) lastSyncedByCampaign.set(id, r.synced_at as string);
  }
  outboundCampaigns.sort((a, b) => {
    const at = lastSyncedByCampaign.get(a.id) || "";
    const bt = lastSyncedByCampaign.get(b.id) || "";
    return at.localeCompare(bt); // never-synced ("" < any timestamp) sort first
  });

  // Process campaigns in parallel with bounded concurrency. We tried
  // CONCURRENCY=20 and watched 473/477 calls abort at the 8s timeout —
  // Bison's per-IP rate limiter throttles when too many requests arrive
  // simultaneously from a single Vercel IP. At 6, individual calls stay
  // under 2s and the overall work still fits the 270s instance budget
  // (477 campaigns × 1s / 6 workers ≈ 80s).
  const CONCURRENCY = 6;
  await parallelForEach(outboundCampaigns, CONCURRENCY, async (campaign) => {
    state.campaignsScanned++;
    try {
      const leads = await listCampaignLeads(instanceKey, campaign.id, {
        leadCampaignStatus: "sequence_finished",
      });

      const candidates = leads.filter((lead) => {
        // Exclude bounced leads
        if (lead.status === "bounced") return false;
        // Exclude leads who replied
        const replies = lead.overall_stats?.replies ?? 0;
        if (replies > 0) return false;
        // Also check campaign-specific replies if available
        const campData = lead.lead_campaign_data;
        if (campData && !Array.isArray(campData)) {
          if ((campData.replies ?? 0) > 0) return false;
          if (campData.status === "bounced") return false;
        }
        return true;
      });

      state.candidatesFound += candidates.length;
      if (candidates.length === 0) return;

      const clientTag = extractTagFromCampaignName(campaign.name) || null;

      const rows = candidates.map((lead: OutboundLead) => ({
        ob_lead_id: lead.id,
        ob_campaign_id: campaign.id,
        campaign_name: campaign.name,
        client_tag: clientTag,
        email: lead.email,
        first_name: lead.first_name,
        last_name: lead.last_name,
        company: lead.company,
        custom_variables: lead.custom_variables || [],
        sequence_finished_at: lead.updated_at,
        synced_at: new Date().toISOString(),
        bison_instance: instanceKey,
      }));

      // Dedupe within the batch — Bison's listCampaignLeads can return the
      // same (lead_id, campaign_id) twice when pagination overlaps, and
      // Postgres rejects the entire batch with "ON CONFLICT DO UPDATE
      // command cannot affect row a second time" if there are duplicates.
      // Keep the last occurrence (latest sync data).
      const dedupedByKey = new Map<string, typeof rows[number]>();
      for (const r of rows) {
        dedupedByKey.set(`${r.ob_lead_id}:${r.ob_campaign_id}:${r.bison_instance}`, r);
      }
      const dedupedRows = Array.from(dedupedByKey.values());

      // Unique constraint is (ob_lead_id, ob_campaign_id, bison_instance)
      // — see the Phase-1 SQL. Without bison_instance in the conflict key,
      // two instances issuing the same numeric IDs would overwrite each
      // other.
      const { error } = await supabase
        .from("nurture_sequence_finished")
        .upsert(dedupedRows, { onConflict: "ob_lead_id,ob_campaign_id,bison_instance" });

      if (error) {
        errors.push(`[${instanceKey}] Campaign ${campaign.id} (${campaign.name}): ${error.message}`);
      } else {
        state.upserted += dedupedRows.length;
        // Fire-and-forget ESP detection on the freshly-inserted rows.
        // Doesn't block the sync; backfill-esp.ts script picks up any
        // misses on the next pass.
        import("@/lib/email-guard").then(({ lookupEmailHost }) => {
          for (const r of dedupedRows) {
            if (!r.email) continue;
            lookupEmailHost(r.email).then((host) => {
              if (!host) return;
              supabase.from("nurture_sequence_finished")
                .update({ esp: host })
                .eq("ob_lead_id", r.ob_lead_id)
                .eq("ob_campaign_id", r.ob_campaign_id)
                .eq("bison_instance", instanceKey)
                .then(({ error: espErr }) => {
                  if (espErr) console.error("[sync-sequence-finished] esp update failed:", espErr.message);
                });
            }).catch((e) => console.error("[sync-sequence-finished] esp lookup failed:", e));
          }
        });
      }
    } catch (e) {
      errors.push(`[${instanceKey}] Campaign ${campaign.id} (${campaign.name}): ${(e as Error).message}`);
    }
  });

  return { instance: instanceKey, ...state };
}

// Per-instance hard cap. Vercel kills the whole route at 5 min
// (maxDuration). With 477 worth-syncing campaigns on outboundhero at
// ~1 s each across 20 workers, the inner loop needs ~25 s ideal /
// 200 s worst case (with timeouts firing). Give each instance most of
// the route's budget — leave only the seconds needed to log + flush.
const INSTANCE_TIMEOUT_MS = 4.5 * 60 * 1000; // 270s — leaves 30s headroom inside the 5-min route

function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        if (onTimeout) {
          // Surface whatever partial progress the worker has accumulated
          // so the operator can see "made it through 200 of 477" rather
          // than the misleading "0 campaigns scanned".
          const partial = onTimeout();
          resolve(partial);
        } else {
          reject(new Error(`${label}: timed out after ${ms / 1000}s`));
        }
      }, ms);
    }),
  ]);
}

export async function syncSequenceFinished(): Promise<SyncResult> {
  // Fan out across every Bison instance in parallel. allSettled means a
  // single instance being down (bad token, network blip, etc.) only
  // affects its own result — the others still complete. The per-instance
  // timeout above prevents a hanging instance from eating the whole
  // route-level budget.
  //
  // We pre-allocate the state object for each instance OUTSIDE the call
  // so the withTimeout's onTimeout handler can read whatever partial
  // progress had been written to it when the timer fires — instead of
  // misleadingly reporting "0 campaigns scanned".
  const settled = await Promise.allSettled(
    BISON_INSTANCES.map((i) => {
      const state: InstanceSyncState = { campaignsScanned: 0, candidatesFound: 0, upserted: 0, errors: [] };
      return withTimeout(
        syncOneInstance(i.key, state),
        INSTANCE_TIMEOUT_MS,
        `instance ${i.key}`,
        () => ({ instance: i.key, ...state, errors: [...state.errors, `[${i.key}] timed out after ${INSTANCE_TIMEOUT_MS / 1000}s — partial progress shown`] }),
      );
    }),
  );

  const perInstance: InstanceSyncResult[] = [];
  const errors: string[] = [];
  let campaignsScanned = 0;
  let candidatesFound = 0;
  let upserted = 0;

  settled.forEach((s, idx) => {
    const key = BISON_INSTANCES[idx].key;
    if (s.status === "fulfilled") {
      perInstance.push(s.value);
      campaignsScanned += s.value.campaignsScanned;
      candidatesFound += s.value.candidatesFound;
      upserted += s.value.upserted;
      errors.push(...s.value.errors);
    } else {
      const msg = (s.reason as Error)?.message || "unknown";
      const fail: InstanceSyncResult = {
        instance: key,
        campaignsScanned: 0,
        candidatesFound: 0,
        upserted: 0,
        errors: [`[${key}] instance sync failed: ${msg}`],
      };
      perInstance.push(fail);
      errors.push(...fail.errors);
    }
  });

  return { campaignsScanned, candidatesFound, upserted, errors, perInstance };
}
