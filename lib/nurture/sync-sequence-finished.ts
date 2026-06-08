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
import { listCampaigns, listCampaignLeads, type OutboundLead, type OutboundCampaign } from "@/lib/outboundhero-api";
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
    syncInstanceByClients(instanceKey, state),
    INSTANCE_TIMEOUT_MS,
    `instance ${instanceKey}`,
    () => ({ instance: instanceKey, ...state, errors: [...state.errors, `[${instanceKey}] timed out after ${INSTANCE_TIMEOUT_MS / 1000}s — partial progress shown`] }),
  );
}

/**
 * Per-instance sync that iterates CLIENTS instead of trying to process
 * every campaign on the instance at once.
 *
 * Why this exists: the old syncOneInstance fetched all ~477 outboundhero
 * campaigns and ran them through a worker pool. Bison's per-IP rate
 * limit aborted 99% of those calls, and only a few lucky campaigns at
 * the top of the array ever got synced — JPH was at the bottom and
 * stayed empty for days.
 *
 * Per-client iteration uses Bison's `search` filter so each call hits
 * only ~10 campaigns per client. With wall-clock budgeting we sweep
 * through clients oldest-synced-first, gracefully exiting when budget
 * is close to spent. Next cron tick picks up where we left off.
 */
async function syncInstanceByClients(instanceKey: BisonInstanceKey, state: InstanceSyncState): Promise<InstanceSyncResult> {
  const startedAt = Date.now();
  // Leave a few seconds for log persistence + response serialization.
  const SOFT_BUDGET_MS = INSTANCE_TIMEOUT_MS - 30_000;

  const tags = await listClientTagsForInstance(instanceKey);
  // Sort oldest-synced first so each tick covers different clients.
  // Clients never synced have synced_at = epoch and sort first.
  const lastSyncedByTag = await loadLastSyncedByTag(instanceKey);
  tags.sort((a, b) => {
    const at = lastSyncedByTag.get(a) || "";
    const bt = lastSyncedByTag.get(b) || "";
    return at.localeCompare(bt);
  });

  for (const tag of tags) {
    if (Date.now() - startedAt > SOFT_BUDGET_MS) {
      state.errors.push(`[${instanceKey}] soft budget hit at ${(Date.now() - startedAt) / 1000}s; remaining clients will sync on next cron tick`);
      break;
    }
    try {
      // Autonomous sync caps at 50 pages per campaign (~750 leads). For
      // mega-campaigns like JPNYC's 1,021-page Outlook (15k leads), the
      // most recent 50 pages get refreshed each tick; older leads stay
      // synced from earlier runs. Manual /api/cron/nurture-sync-client
      // uses no cap so operators can do a full backfill on demand.
      const r = await syncOneClient(instanceKey, tag, { maxPagesPerCampaign: 50 });
      state.campaignsScanned += r.campaignsScanned;
      state.candidatesFound += r.candidatesFound;
      state.upserted += r.upserted;
      state.errors.push(...r.errors);
    } catch (e) {
      state.errors.push(`[${instanceKey}] client ${tag} sync failed: ${(e as Error).message}`);
    }
  }

  return { instance: instanceKey, ...state };
}

/** All client tags that should sync against the given Bison instance.
 *  Pulls from Turso client_tags (full catalogue) and joins to
 *  client_instances to map each to its instance. Tags without an
 *  explicit mapping fall back to DEFAULT_INSTANCE (outboundhero). */
async function listClientTagsForInstance(instanceKey: BisonInstanceKey): Promise<string[]> {
  const { default: turso } = await import("@/lib/db");
  const res = await turso.execute({
    sql: `SELECT ct.tag, ci.instance_key
          FROM client_tags ct
          LEFT JOIN client_instances ci ON ci.client_tag = ct.tag`,
    args: [],
  });
  const out: string[] = [];
  for (const row of res.rows) {
    const tag = row.tag as string;
    const mapped = (row.instance_key as string | null) || "outboundhero";
    if (mapped === instanceKey) out.push(tag);
  }
  return out;
}

async function loadLastSyncedByTag(instanceKey: BisonInstanceKey): Promise<Map<string, string>> {
  const { data } = await supabase
    .from("nurture_sequence_finished")
    .select("client_tag, synced_at")
    .eq("bison_instance", instanceKey)
    .order("synced_at", { ascending: false });
  const out = new Map<string, string>();
  for (const r of data || []) {
    const tag = (r.client_tag as string) || "";
    if (!tag) continue;
    if (!out.has(tag)) out.set(tag, r.synced_at as string);
  }
  return out;
}

/**
 * Sync a single client's campaigns on a specific Bison instance.
 *
 * Uses Bison's `search` query param to filter to that client tag's
 * campaigns only (e.g. JPH: ~10 campaigns instead of outboundhero's
 * 477). Much smaller per-call work — fits comfortably in the rate
 * limit without aborts. Useful for:
 *   - manually backfilling a specific client (curl /api/cron/nurture-sync-client/JPH)
 *   - per-client cron in the future
 */
export async function syncOneClient(
  instanceKey: BisonInstanceKey,
  clientTag: string,
  opts: { maxPagesPerCampaign?: number } = {},
): Promise<InstanceSyncResult> {
  const state: InstanceSyncState = { campaignsScanned: 0, candidatesFound: 0, upserted: 0, errors: [] };

  // Bison's `search` filter narrows the list server-side. For "JPH" we
  // get ~10 campaigns instead of 477 — well inside any rate limit.
  // Server-side status filter still applies so we skip drafts/archived.
  const matched = await listCampaigns(instanceKey, {
    statuses: ["active", "completed", "paused", "stopped"],
    search: `${clientTag}:`,
  });

  // The search filter is fuzzy — it may match campaigns from other clients
  // whose names happen to contain the tag string. Tighten to exact prefix
  // match on the "TAG:" convention we use everywhere.
  const exactCampaigns = matched.filter((c) => {
    const name = c.name?.toLowerCase() || "";
    if (name.includes("[nurture]") || c.type === "nurture") return false;
    const tag = (extractTagFromCampaignName(c.name) || "").toUpperCase();
    return tag === clientTag.toUpperCase();
  });

  const usableCampaigns = exactCampaigns.filter((c) => {
    const total = c.total_leads ?? 0;
    if (total === 0) return false;
    const exhausted = (c.replied ?? 0) + (c.bounced ?? 0);
    if (exhausted >= total) return false;
    return true;
  });

  await processCampaigns(instanceKey, usableCampaigns, state, { maxPagesPerCampaign: opts.maxPagesPerCampaign });
  return { instance: instanceKey, ...state };
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

  await processCampaigns(instanceKey, outboundCampaigns, state);
  return { instance: instanceKey, ...state };
}

/**
 * Process a pre-filtered list of campaigns: fetch sequence_finished
 * leads for each, dedupe, upsert into nurture_sequence_finished.
 * Mutates `state` for live progress reporting.
 *
 * Bounded concurrency at 6 — empirically the sweet spot before Bison's
 * per-IP rate limiter starts dropping calls (verified by watching
 * 473/477 aborts at CONCURRENCY=20 on outboundhero).
 */
async function processCampaigns(
  instanceKey: BisonInstanceKey,
  campaigns: OutboundCampaign[],
  state: InstanceSyncState,
  opts: { maxPagesPerCampaign?: number } = {},
): Promise<void> {
  const errors = state.errors;
  const CONCURRENCY = 6;
  await parallelForEach(campaigns, CONCURRENCY, async (campaign) => {
    state.campaignsScanned++;
    try {
      const leads = await listCampaignLeads(instanceKey, campaign.id, {
        leadCampaignStatus: "sequence_finished",
        maxPages: opts.maxPagesPerCampaign,
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
