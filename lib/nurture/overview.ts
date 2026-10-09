/**
 * Nurture System overview (the approved redesign) — one record per active
 * client tag, merged from data that is already kept fresh elsewhere:
 *
 *   Turso (live, ~50ms):  campaign snapshots (nurture + main, refreshed every
 *                         10 min), the target-campaign map, expansion batches,
 *                         routing health, client groups / type, churn.
 *   Sheet (cached):       go-live dates → "Pre-launch".
 *   Supabase SQL:         per-tag queue stats (nurture_tag_stats — queue, ready,
 *                         cooldown, sources, ESPs, domain endings, forecast,
 *                         overlap), cached in Turso by the refresh-nurture-
 *                         overview cron (they take a few seconds per tag).
 *   Bison (cron):         "last contact" — the latest day a tag's active nurture
 *                         campaigns actually sent (line-area-chart Sent series).
 *
 * Pages read the merged result instantly; nothing here calls Bison on a page load.
 */
import db from "@/lib/db";
import supabase from "@/lib/supabase";
import { getAllClientInstances } from "@/lib/nurture/group-routing";
import { getChurnedClients } from "@/lib/churn";
import { fetchNotYetLiveTags, NURTURE_GOLIVE_LAG_DAYS } from "@/lib/google-sheets";
import { isCanonicalNurtureCampaign, detectCampaignEsp, type Esp } from "@/lib/nurture/esp";
import { trioReadyToExpand } from "@/lib/nurture/campaign-expansion";
import { getInstanceConfig, getInstanceLabel } from "@/lib/bison-instances";
import { toQueueContact } from "@/lib/nurture/queue-filters";
import { acquireHeavyLease, renewHeavyLease, releaseHeavyLease, leaseHolder } from "@/lib/nurture/heavy-lease";

export const ESPS: Esp[] = ["google", "outlook", "segs"];
const ON = new Set(["active", "queued"]);
const NO_LEADS_HOURS = 48;

export type BatchState = "on" | "wait" | "off";
export type ClientType = "Cleaning" | "Non-Cleaning" | "OS";
export interface CronState { at?: string; churned?: number; active?: number; manual?: boolean; checked?: number; newlyMapped?: number; remapped?: number }
export interface StatusBadge { k: "prelaunch" | "map" | "draft" | "archived" | "noleads"; lab: string; tip: string }

export interface TagStats {
  queue: number; eligible: number; ready: number; cooldown: number; esp_unresolved: number;
  sources: Record<string, number>; esps: Record<string, number>; tlds: Record<string, number>;
  email_endings: Record<string, number>; site_endings: Record<string, number>;
  email_domains?: Record<string, number>;  // personal mailbox domains (newer stats only)
  forecast: number[]; overlap: number; last_new_at: string | null; computed_at: string;
  overlap_at?: string;                     // when `overlap` was computed (overnight job)
}

export interface NurtureCampaignRef {
  id: number; instance: string; name: string; status: string; esp: Esp | null; batch: number; totalLeads: number;
}

export interface MapSlot {
  lane: "b2b" | "b2c"; instance: string; instanceLabel: string; esp: Esp;
  campaignId: number | null; campaignName: string | null; status: string | null;
  issue: "unmapped" | "missing" | "archived" | "draft" | null;
}

export interface OverviewTag {
  tag: string;
  type: ClientType;
  group: number | null;
  b2b: string | null;
  b2c: string | null;
  autoOn: boolean;
  prelaunch: boolean;
  mainActive: number;
  mainTotal: number;
  nurtureActive: number;
  nurtureTotal: number;
  sendingLeads: number;              // leads sitting in ACTIVE nurture campaigns
  mapping: "ok" | "bad";
  mapIssues: string[];
  mapConfirmed: boolean;
  batches: [BatchState, BatchState, BatchState];
  extraLiveBatches: number;          // live batches beyond N3 (rare)
  readyToExpand: boolean;
  lastContactDay: string | null;     // YYYY-MM-DD of the latest nurture send
  lastContactCheckedAt: string | null;
  stats: TagStats | null;
  added: number | null;              // distinct contacts already pushed (nurture_summary_cache)
  stoppedRecovered: number;          // stopped leads recovered straight into campaigns (never queued)
  errors: StatusBadge[];
  slots: MapSlot[];                  // target campaigns, lane × instance × ESP (client page)
  batchCampaigns: Array<{ batch: number; state: BatchState; campaigns: Array<NurtureCampaignRef & { instanceLabel: string }> }>;
}

// ── Turso caches written by the cron ─────────────────────────────────────────
let tablesReady: Promise<void> | null = null;
export function ensureOverviewTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = db.batch([
      "CREATE TABLE IF NOT EXISTS nurture_tag_stats_cache (client_tag TEXT PRIMARY KEY, stats TEXT, computed_at TEXT)",
      "CREATE TABLE IF NOT EXISTS nurture_campaign_last_sent (campaign_id INTEGER, bison_instance TEXT, client_tag TEXT, last_sent_day TEXT, checked_at TEXT, PRIMARY KEY (campaign_id, bison_instance))",
      "CREATE TABLE IF NOT EXISTS cron_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)",
      "CREATE TABLE IF NOT EXISTS nurture_queue_page1_cache (client_tag TEXT PRIMARY KEY, payload TEXT, computed_at TEXT)",
      "CREATE TABLE IF NOT EXISTS nurture_tag_stats_dirty (client_tag TEXT PRIMARY KEY, dirty_at TEXT)",
      "CREATE TABLE IF NOT EXISTS nurture_tag_stats_fail (client_tag TEXT PRIMARY KEY, attempted_at TEXT, error TEXT, failures INTEGER)",
    ], "write")
      // Upgrade tables created before a column existed (no-op once added).
      .then(() => db.execute("ALTER TABLE nurture_tag_stats_fail ADD COLUMN failures INTEGER").catch(() => undefined))
      .then(() => undefined).catch((e) => { tablesReady = null; throw e; });
  }
  return tablesReady;
}

export async function setCronState(key: string, value: unknown): Promise<void> {
  await ensureOverviewTables();
  await db.execute({
    sql: "INSERT INTO cron_state (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    args: [key, JSON.stringify(value)],
  });
}
async function getCronState<T>(key: string): Promise<T | null> {
  const r = await db.execute({ sql: "SELECT value FROM cron_state WHERE key = ?", args: [key] });
  try { return r.rows[0] ? (JSON.parse(String(r.rows[0].value)) as T) : null; } catch { return null; }
}

/** "[Nurture]" → 1, "[Nurture 3]" → 3, legacy "— Batch 2" → 2. */
export function nurtureBatchOf(name: string): number {
  const marker = name.match(/\[nurture\s*(\d+)\]/i);
  if (marker) return Math.max(1, Number(marker[1]));
  const suffix = name.match(/[—-]\s*batch\s*(\d+)\s*$/i);
  return suffix ? Math.max(1, Number(suffix[1])) : 1;
}

function typeFrom(metaType: string | null, nurtureNames: string[]): ClientType {
  const t = String(metaType || "").trim().toLowerCase();
  if (t === "os") return "OS";
  if (t === "non-cleaning" || t === "non cleaning") return "Non-Cleaning";
  if (t === "cleaning") return "Cleaning";
  if (nurtureNames.some((n) => /\(os client\)/i.test(n))) return "OS";
  if (nurtureNames.some((n) => /\(non-?cleaning client\)/i.test(n))) return "Non-Cleaning";
  return "Cleaning";
}

const hoursAgo = (iso: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / 3_600_000 : Infinity);

/** Active (non-churned) client tags, sorted. */
export async function activeClientTags(): Promise<{ tags: string[]; churned: string[] }> {
  const [tagRows, churnedMap] = await Promise.all([
    db.execute("SELECT DISTINCT tag FROM client_tags"),
    getChurnedClients(),
  ]);
  const churned = [...churnedMap.keys()].map((t) => t.toUpperCase());
  const churnedSet = new Set(churned);
  const tags = [...new Set(tagRows.rows.map((r) => String(r.tag).trim()).filter(Boolean))]
    .filter((t) => t.toUpperCase() !== "N/A" && !churnedSet.has(t.toUpperCase()))
    .sort((a, b) => a.localeCompare(b));
  return { tags, churned };
}

/** Build the overview for every active tag. */
export async function buildOverview(): Promise<{
  tags: OverviewTag[];
  churned: string[];
  automation: { churnSync: CronState | null; refresh: CronState | null; mappedTags: number };
  campaignsSyncedAt: string | null;
}> {
  await ensureOverviewTables();
  const { tags: allTags, churned } = await activeClientTags();
  const wanted = allTags;

  const [instances, notLive, nurtRows, mainRows, mapRows, cfgRows, healthRows, metaRows, statRows, lastRows, summaryRows, churnState, refreshState, recRows] = await Promise.all([
    getAllClientInstances(),
    fetchNotYetLiveTags(NURTURE_GOLIVE_LAG_DAYS).catch(() => new Set<string>()),
    db.execute("SELECT id, name, status, client_tag, total_leads, bison_instance, synced_at FROM nurture_campaigns_cache"),
    db.execute("SELECT client_tag, status FROM main_campaigns_cache").catch(() => ({ rows: [] as unknown[] })),
    db.execute("SELECT client_tag, bison_instance, esp, campaign_id, campaign_name FROM nurture_campaign_map"),
    db.execute("SELECT client_tag, auto_nurture_disabled, nurture_map_confirmed_at FROM client_config"),
    db.execute("SELECT client_tag, bison_instance, esp, completion_percentage, total_leads FROM nurture_routing_health").catch(() => ({ rows: [] as unknown[] })),
    db.execute("SELECT client_tag, client_type FROM client_meta").catch(() => ({ rows: [] as unknown[] })),
    db.execute("SELECT client_tag, stats FROM nurture_tag_stats_cache"),
    db.execute("SELECT client_tag, bison_instance, campaign_id, last_sent_day, checked_at FROM nurture_campaign_last_sent"),
    supabase.from("nurture_summary_cache").select("client_tag, added"),
    getCronState<CronState>("nurture:churn-sync"),
    getCronState<CronState>("nurture:auto-map"),
    db.execute("SELECT UPPER(client_tag) AS t, COUNT(*) AS n FROM nurture_stopped_recovered WHERE added_at IS NOT NULL GROUP BY 1").catch(() => ({ rows: [] as unknown[] })),
  ]);

  const up = (v: unknown) => String(v ?? "").trim().toUpperCase();
  let campaignsSyncedAt: string | null = null;

  // Canonical nurture campaigns per tag.
  const nurtByTag = new Map<string, NurtureCampaignRef[]>();
  const campById = new Map<string, NurtureCampaignRef>(); // `${instance}:${id}`
  for (const r of nurtRows.rows) {
    if (r.synced_at && (!campaignsSyncedAt || String(r.synced_at) > campaignsSyncedAt)) campaignsSyncedAt = String(r.synced_at);
    const name = String(r.name || "");
    const ref: NurtureCampaignRef = {
      id: Number(r.id), instance: String(r.bison_instance), name, status: String(r.status || "").toLowerCase(),
      esp: detectCampaignEsp(name), batch: nurtureBatchOf(name), totalLeads: Number(r.total_leads) || 0,
    };
    campById.set(`${ref.instance}:${ref.id}`, ref);
    if (!isCanonicalNurtureCampaign(name)) continue;
    const T = up(r.client_tag);
    if (!nurtByTag.has(T)) nurtByTag.set(T, []);
    nurtByTag.get(T)!.push(ref);
  }
  const mainByTag = new Map<string, { active: number; total: number }>();
  for (const r of mainRows.rows as Array<Record<string, unknown>>) {
    const T = up(r.client_tag);
    const m = mainByTag.get(T) ?? { active: 0, total: 0 };
    m.total++;
    if (ON.has(String(r.status || "").toLowerCase())) m.active++;
    mainByTag.set(T, m);
  }
  const mapByTag = new Map<string, Array<{ instance: string; esp: Esp; id: number; name: string | null }>>();
  for (const r of mapRows.rows) {
    const T = up(r.client_tag);
    if (!mapByTag.has(T)) mapByTag.set(T, []);
    mapByTag.get(T)!.push({ instance: String(r.bison_instance), esp: String(r.esp) as Esp, id: Number(r.campaign_id), name: (r.campaign_name as string) ?? null });
  }
  const cfgByTag = new Map<string, { autoOn: boolean; confirmed: boolean }>();
  for (const r of cfgRows.rows) cfgByTag.set(up(r.client_tag), { autoOn: Number(r.auto_nurture_disabled) !== 1, confirmed: !!r.nurture_map_confirmed_at });
  const healthByTag = new Map<string, Map<string, Map<Esp, { completion: number; total: number }>>>();
  for (const r of healthRows.rows as Array<Record<string, unknown>>) {
    const T = up(r.client_tag), inst = String(r.bison_instance || ""), esp = String(r.esp || "") as Esp;
    if (!T || !inst || !ESPS.includes(esp)) continue;
    if (!healthByTag.has(T)) healthByTag.set(T, new Map());
    const im = healthByTag.get(T)!;
    if (!im.has(inst)) im.set(inst, new Map());
    im.get(inst)!.set(esp, { completion: Number(r.completion_percentage) || 0, total: Number(r.total_leads) || 0 });
  }
  const typeByTag = new Map<string, string>();
  for (const r of metaRows.rows as Array<Record<string, unknown>>) typeByTag.set(up(r.client_tag), String(r.client_type || ""));
  const statsByTag = new Map<string, TagStats>();
  for (const r of statRows.rows) { try { statsByTag.set(up(r.client_tag), JSON.parse(String(r.stats))); } catch { /* skip bad row */ } }
  const lastByCampaign = new Map<string, { day: string | null; checked: string | null }>();
  for (const r of lastRows.rows) lastByCampaign.set(`${r.bison_instance}:${r.campaign_id}`, { day: (r.last_sent_day as string) ?? null, checked: (r.checked_at as string) ?? null });
  const addedByTag = new Map<string, number>();
  for (const r of summaryRows.data || []) addedByTag.set(up(r.client_tag), Number(r.added) || 0);
  const recByTag = new Map<string, number>();
  for (const r of recRows.rows as Array<Record<string, unknown>>) recByTag.set(up(r.t), Number(r.n) || 0);

  const out: OverviewTag[] = [];
  for (const tag of wanted) {
    const T = tag.toUpperCase();
    const inst = instances.get(T) ?? null;
    const camps = nurtByTag.get(T) ?? [];
    const cfg = cfgByTag.get(T);
    const prelaunch = notLive.has(T);
    const main = mainByTag.get(T) ?? { active: 0, total: 0 };
    const neededInst = inst ? [...new Set([inst.b2b, inst.b2c])] : [];
    const relevant = camps.filter((c) => neededInst.length === 0 || neededInst.includes(c.instance as never));
    const active = relevant.filter((c) => ON.has(c.status));

    // ── mapping
    const map = mapByTag.get(T) ?? [];
    const mapIssues: string[] = [];
    let unmapped = 0, archived = 0, drafts = 0, missing = 0;
    if (!inst) mapIssues.push("No client group (Group 1 / 2) assigned, so there are no target instances.");
    for (const instance of neededInst) {
      for (const esp of ESPS) {
        const m = map.find((x) => x.instance === instance && x.esp === esp);
        if (!m) { unmapped++; continue; }
        const c = campById.get(`${instance}:${m.id}`);
        if (!c) missing++;
        else if (c.status === "archived") archived++;
        // A draft with no leads is normal (auto-push launches it when the first
        // leads route in); leads sitting in a draft can't send — that's a fault.
        else if (c.status === "draft" && c.totalLeads > 0) drafts++;
      }
    }
    const slots = neededInst.length * ESPS.length;
    if (inst && map.length === 0) mapIssues.push("No nurture campaigns are mapped.");
    else if (unmapped) mapIssues.push(`${unmapped} of ${slots} ESP slots have no nurture campaign.`);
    if (missing) mapIssues.push(`${missing} mapped campaign${missing > 1 ? "s" : ""} no longer exist${missing > 1 ? "" : "s"} in Bison.`);
    if (archived) mapIssues.push(`${archived} mapped campaign${archived > 1 ? "s are" : " is"} archived.`);
    // Auto-push only routes to a confirmed map (auto-map confirms the maps it fills).
    if (inst && map.length > 0 && !cfg?.confirmed) mapIssues.push("The target campaigns aren't confirmed yet, so ready leads aren't routed (saving them confirms them).");
    const mapping: "ok" | "bad" = mapIssues.length ? "bad" : "ok";

    // ── batches N1..N3 (per tag, across its instances)
    let readyToExpand = false;
    for (const [, espMap] of healthByTag.get(T) ?? new Map()) {
      const cells = ESPS.map((e) => espMap.get(e)).filter(Boolean) as { completion: number; total: number }[];
      if (trioReadyToExpand(cells).ready) readyToExpand = true;
    }
    // Archived campaigns are retired: they never make a batch live or "set up".
    const current = relevant.filter((c) => c.status !== "archived");
    const maxBatch = current.reduce((m, c) => Math.max(m, c.batch), 0);
    const batchState = (k: number): BatchState => {
      const inBatch = current.filter((c) => c.batch === k);
      if (inBatch.some((c) => ON.has(c.status))) return "on";
      if (inBatch.length) return "wait";                       // set up, not active yet
      if (k > 1 && k === maxBatch + 1 && readyToExpand) return "wait"; // threshold met — next expansion run creates it
      return "off";
    };
    const batches: [BatchState, BatchState, BatchState] = [batchState(1), batchState(2), batchState(3)];
    const extraLiveBatches = new Set(relevant.filter((c) => c.batch > 3 && ON.has(c.status)).map((c) => c.batch)).size;

    // ── last contact = newest send day across the tag's ACTIVE nurture campaigns
    let lastContactDay: string | null = null, lastContactCheckedAt: string | null = null;
    for (const c of active) {
      const l = lastByCampaign.get(`${c.instance}:${c.id}`);
      if (!l) continue;
      if (l.day && (!lastContactDay || l.day > lastContactDay)) lastContactDay = l.day;
      if (l.checked && (!lastContactCheckedAt || l.checked > lastContactCheckedAt)) lastContactCheckedAt = l.checked;
    }

    const stats = statsByTag.get(T) ?? null;

    // ── target-campaign slots + batch campaigns (client page), from the same data
    const mapSlots: MapSlot[] = [];
    if (inst) {
      for (const [lane, instance] of [["b2b", inst.b2b], ["b2c", inst.b2c]] as const) {
        for (const esp of ESPS) {
          const m = map.find((x) => x.instance === instance && x.esp === esp);
          const c = m ? campById.get(`${instance}:${m.id}`) : undefined;
          mapSlots.push({
            lane, instance, instanceLabel: getInstanceLabel(instance), esp,
            campaignId: m ? m.id : null, campaignName: c?.name ?? m?.name ?? null, status: c?.status ?? null,
            issue: !m ? "unmapped" : !c ? "missing" : c.status === "archived" ? "archived" : c.status === "draft" ? "draft" : null,
          });
        }
      }
    }
    // Client page rows: N1–N3 always, plus every later batch with current campaigns.
    const batchNums = [1, 2, 3, ...[...new Set(current.map((c) => c.batch).filter((b) => b > 3))].sort((a, b) => a - b)];
    const batchCampaigns = batchNums.map((k) => ({
      batch: k,
      state: batchState(k),
      campaigns: current.filter((c) => c.batch === k).map((c) => ({ ...c, instanceLabel: getInstanceLabel(c.instance) })),
    }));

    // ── status badges (each with the hover "what + how to fix")
    const errors: StatusBadge[] = [];
    if (prelaunch) {
      errors.push({ k: "prelaunch", lab: "Pre-launch", tip: "Go-live is in the future — campaigns stay paused and nurture is held until launch." });
    } else {
      if (inst && map.length === 0) errors.push({ k: "map", lab: "No mapping", tip: `No canonical [Nurture] campaigns are mapped. Create them in Bison (${tag}: Google + Custom / Outlook / SEGs [Nurture] (… Client)) and the refresh maps them automatically.` });
      else if (mapping === "bad") errors.push({ k: "map", lab: "Mapping issue", tip: mapIssues.join(" ") + " Fix the campaigns in Bison, or edit Target campaigns." });
      if (drafts) errors.push({ k: "draft", lab: "Campaigns in draft", tip: `${drafts} mapped nurture campaign${drafts > 1 ? "s hold" : " holds"} leads but ${drafts > 1 ? "are" : "is"} still in Draft, so nothing sends. Usually no sender inboxes for this client are connected on that instance — auto-launch skips a campaign with no senders. Tag + connect the inboxes, then Target campaigns → Edit → Save & enable sending.` });
      if (archived) errors.push({ k: "archived", lab: "Archived on active", tip: `An archived nurture campaign is still mapped for this active client. Re-point the map to a live campaign (Target campaigns → Edit).` });
      if (stats && main.active > 0 && hoursAgo(stats.last_new_at) > NO_LEADS_HOURS) {
        const since = stats.last_new_at ? `since ${new Date(stats.last_new_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "at all";
        errors.push({ k: "noleads", lab: "Not receiving leads", tip: `No new leads have entered this tag's queue ${since} despite ${main.active} active main campaign${main.active > 1 ? "s" : ""}. Check ESP tagging + the sequence-finished sync.` });
      }
    }

    out.push({
      tag, type: typeFrom(typeByTag.get(T) ?? null, camps.map((c) => c.name)),
      group: inst?.group ?? null, b2b: inst?.b2b ?? null, b2c: inst?.b2c ?? null,
      autoOn: cfg?.autoOn ?? true, prelaunch,
      mainActive: main.active, mainTotal: main.total,
      nurtureActive: active.length, nurtureTotal: relevant.length,
      sendingLeads: active.reduce((s, c) => s + c.totalLeads, 0),
      mapping, mapIssues, mapConfirmed: !!cfg?.confirmed,
      batches, extraLiveBatches, readyToExpand,
      lastContactDay, lastContactCheckedAt,
      stats, added: addedByTag.get(T) ?? null,
      stoppedRecovered: recByTag.get(T) ?? 0,
      errors,
      slots: mapSlots, batchCampaigns,
    });
  }

  const mappedTags = allTags.filter((t) => cfgByTag.get(t.toUpperCase())?.confirmed).length;
  return { tags: out, churned, automation: { churnSync: churnState, refresh: refreshState, mappedTags }, campaignsSyncedAt };
}

// ── Cron work: per-tag SQL stats (rotating, stalest first) ───────────────────
/**
 * Is the shared database busy right now? Times a trivial primary-key read
 * (normally ~50-150ms); the stats cron yields — skips or stops — when it's
 * slow, so the inbox always comes first.
 */
export async function dbIsBusy(thresholdMs = 700): Promise<boolean> {
  const one = async () => {
    const t = Date.now();
    const { error } = await supabase.from("replies").select("id").order("id", { ascending: false }).limit(1);
    return error ? Infinity : Date.now() - t;
  };
  const a = await one();
  if (a < thresholdMs) return false;
  return (await one()) >= thresholdMs; // confirm (network blips happen)
}

/**
 * Is the light stats SQL (patch 2: no overlap scan, first page in the same
 * pass) installed? Probed with nurture_tag_overlap on a tag that doesn't
 * exist (instant). Until it is, the stats CRON stays off — the old function
 * was a 10-30s disk-bound query that slowed the inbox. Cached 10 min.
 */
let lightProbe: { at: number; ok: boolean } | null = null;
export async function lightStatsInstalled(): Promise<boolean> {
  if (lightProbe && Date.now() - lightProbe.at < 600_000) return lightProbe.ok;
  const { error } = await supabase.rpc("nurture_tag_overlap", { p_tag: "__probe__", p_ignore_tags: [] });
  lightProbe = { at: Date.now(), ok: !error };
  return lightProbe.ok;
}

const LEASE_TTL_MS = 150_000;
const BETWEEN_TAGS_MS = 2_000;   // pause between heavy per-tag queries      // > the stats function's 120s statement timeout
// A tag whose stats failed waits 1h, then 2h, 4h … up to 24h before the cron
// retries it (a tag that always times out must not cost 120s every hour).
const failBackoffMs = (failures: number) => Math.min(24, 2 ** Math.max(0, failures - 1)) * 3_600_000;

/**
 * Recompute per-tag queue stats (+ the queue tab's cached first page).
 * These are heavy queries on the live database the inbox also uses, so:
 *   • the whole run holds the system-wide heavy lease — at most one heavy
 *     Nurture query runs anywhere at a time (busy → returns { busy: true });
 *   • tags run strictly one at a time, within `maxMs`;
 *   • the cron only takes dirty tags (changed since last refresh) and tags
 *     older than `minAgeMs`, and skips tags that failed in the last hour.
 * 2026-10-09: 3 parallel stats queries starved the inbox into timeouts.
 */
export async function refreshTagStats(opts: { maxTags?: number; maxMs?: number; tags?: string[]; minAgeMs?: number; yieldToLoad?: boolean } = {}): Promise<{ refreshed: string[]; failed: Array<{ tag: string; error: string }>; busy?: boolean; yielded?: boolean }> {
  await ensureOverviewTables();
  const started = Date.now();
  const { tags: active, churned } = await activeClientTags();
  const canonical = new Map(active.map((t) => [t.toUpperCase(), t]));
  let order: string[];
  if (opts.tags) {
    // Exact stored spelling of each requested tag; unknown / churned ones are skipped.
    order = opts.tags.map((t) => canonical.get(t.trim().toUpperCase())).filter(Boolean) as string[];
  } else {
    const [statRows, dirtyRows, failRows] = await Promise.all([
      db.execute("SELECT client_tag, computed_at FROM nurture_tag_stats_cache"),
      db.execute("SELECT client_tag FROM nurture_tag_stats_dirty ORDER BY dirty_at"),
      db.execute("SELECT client_tag, attempted_at, failures FROM nurture_tag_stats_fail"),
    ]);
    const at = new Map(statRows.rows.map((x) => [String(x.client_tag).toUpperCase(), String(x.computed_at || "")]));
    const failedRecently = new Set(failRows.rows
      .filter((x) => Date.now() - new Date(String(x.attempted_at)).getTime() < failBackoffMs(Number(x.failures) || 1))
      .map((x) => String(x.client_tag).toUpperCase()));
    let stale = [...active].sort((a, b) => (at.get(a.toUpperCase()) || "").localeCompare(at.get(b.toUpperCase()) || ""));
    if (opts.minAgeMs) {
      const cutoff = Date.now() - opts.minAgeMs;
      stale = stale.filter((t) => { const c = at.get(t.toUpperCase()); return !c || new Date(c).getTime() < cutoff; });
    }
    // Tags changed since their last refresh (queue removals etc.) go first.
    const dirty = dirtyRows.rows.map((x) => canonical.get(String(x.client_tag).toUpperCase())).filter(Boolean) as string[];
    const dirtySet = new Set(dirty);
    order = [...dirty, ...stale.filter((t) => !dirtySet.has(t))].filter((t) => !failedRecently.has(t.toUpperCase()));
  }
  order = order.slice(0, opts.maxTags ?? order.length);
  const refreshed: string[] = [];
  const failed: Array<{ tag: string; error: string }> = [];
  if (order.length === 0) return { refreshed, failed };
  // Automatic runs wait for the light stats SQL (see lightStatsInstalled).
  if (!opts.tags && !(await lightStatsInstalled())) return { refreshed, failed, yielded: true };

  const holder = leaseHolder("tag-stats");
  let yielded = false;
  if (!(await acquireHeavyLease(holder, LEASE_TTL_MS))) return { refreshed, failed, busy: true };
  try {
    const outOfTime = () => !!opts.maxMs && Date.now() - started > opts.maxMs;
    const one = async (tag: string): Promise<string | null> => {
      if (!(await renewHeavyLease(holder, LEASE_TTL_MS))) return "lost the heavy-query lease";
      const startedAt = new Date().toISOString();
      const prevRow = await db.execute({ sql: "SELECT stats FROM nurture_tag_stats_cache WHERE client_tag = ?", args: [tag.toUpperCase()] });
      let prev: Partial<TagStats> = {};
      try { prev = prevRow.rows[0] ? JSON.parse(String(prevRow.rows[0].stats)) : {}; } catch { /* ignore */ }
      const { data, error } = await supabase.rpc("nurture_tag_stats", { p_tag: tag, p_ignore_tags: churned });
      if (error || !data) {
        const msg = error?.message || "no data";
        await db.execute({
          sql: `INSERT INTO nurture_tag_stats_fail (client_tag, attempted_at, error, failures) VALUES (?, ?, ?, 1)
                ON CONFLICT(client_tag) DO UPDATE SET attempted_at = excluded.attempted_at, error = excluded.error,
                  failures = COALESCE(nurture_tag_stats_fail.failures, 1) + 1`,
          args: [tag.toUpperCase(), new Date().toISOString(), msg.slice(0, 300)],
        });
        return msg;
      }
      // The light stats pass (SQL patch 2) returns the queue's first page and no
      // overlap count (that's computed overnight) — keep the last known overlap.
      const { page1, ...statsOnly } = data as Record<string, unknown> & { page1?: Array<Record<string, unknown>> };
      if (statsOnly.overlap === undefined) {
        statsOnly.overlap = prev.overlap ?? null;
        statsOnly.overlap_at = prev.overlap_at ?? (prev.overlap != null ? prev.computed_at : null);
        statsOnly.overlap_tried_at = (prev as { overlap_tried_at?: string }).overlap_tried_at ?? null;
      } else {
        statsOnly.overlap_at = statsOnly.computed_at;
      }
      await db.batch([
        { sql: "INSERT INTO nurture_tag_stats_cache (client_tag, stats, computed_at) VALUES (?, ?, ?) ON CONFLICT(client_tag) DO UPDATE SET stats = excluded.stats, computed_at = excluded.computed_at",
          args: [tag.toUpperCase(), JSON.stringify(statsOnly), new Date().toISOString()] },
        { sql: "DELETE FROM nurture_tag_stats_dirty WHERE client_tag = ? AND dirty_at <= ?", args: [tag.toUpperCase(), startedAt] },
        { sql: "DELETE FROM nurture_tag_stats_fail WHERE client_tag = ?", args: [tag.toUpperCase()] },
      ], "write");
      refreshed.push(tag);
      // The queue tab's first page — straight from the stats pass when the
      // database returns it (no second scan); older SQL: a separate query.
      if (Array.isArray(page1)) {
        await db.execute({
          sql: "INSERT INTO nurture_queue_page1_cache (client_tag, payload, computed_at) VALUES (?, ?, ?) ON CONFLICT(client_tag) DO UPDATE SET payload = excluded.payload, computed_at = excluded.computed_at",
          args: [tag.toUpperCase(), JSON.stringify({ total: Number(statsOnly.queue) || 0, contacts: page1.map(toQueueContact) }), new Date().toISOString()],
        });
        return null;
      }
      try {
        await renewHeavyLease(holder, LEASE_TTL_MS);
        const pg = await supabase.rpc("nurture_queue_page", {
          p_tag: tag, p_search: null, p_email_suffix: null, p_web_suffix: null, p_source: null, p_tld: null,
          p_overlap_only: false, p_ignore_tags: churned, p_limit: 50, p_offset: 0,
        });
        if (!pg.error) {
          const rows = (pg.data || []) as Array<Record<string, unknown>>;
          await db.execute({
            sql: "INSERT INTO nurture_queue_page1_cache (client_tag, payload, computed_at) VALUES (?, ?, ?) ON CONFLICT(client_tag) DO UPDATE SET payload = excluded.payload, computed_at = excluded.computed_at",
            args: [tag.toUpperCase(), JSON.stringify({ total: rows.length ? Number(rows[0].total_count) : 0, contacts: rows.map(toQueueContact) }), new Date().toISOString()],
          });
        }
      } catch { /* the live queue still works */ }
      return null;
    };
    let first = true;
    for (const tag of order) {
      if (outOfTime()) break;
      if (!first) await new Promise((r) => setTimeout(r, BETWEEN_TAGS_MS)); // let the disk breathe
      first = false;
      if (opts.yieldToLoad && (await dbIsBusy())) { yielded = true; break; } // inbox first
      let err: string | null;
      try { err = await one(tag); } catch (e) { err = (e as Error).message || "error"; } // one bad tag never aborts the run
      if (err === "lost the heavy-query lease") break;
      if (err) failed.push({ tag, error: err });
    }
  } finally {
    await releaseHeavyLease(holder).catch(() => {});
  }
  return { refreshed, failed, yielded };
}

/**
 * The "Overlapping" count per tag (contacts also queued in another active
 * client's queue). It's the heaviest part of the numbers, so it runs only
 * overnight (0–6 AM Pacific), one tag at a time, under the heavy lease and
 * yielding to load; each tag is refreshed at most once a day.
 */
export async function refreshTagOverlap(opts: { finishBy: number }): Promise<{ refreshed: string[]; skipped?: string }> {
  await ensureOverviewTables();
  const refreshed: string[] = [];
  const { tags: active, churned } = await activeClientTags();
  const r = await db.execute("SELECT client_tag, stats FROM nurture_tag_stats_cache");
  // Last ATTEMPT per tag (success or failure) — a tag that times out is not
  // retried again the same night.
  const triedAt = new Map<string, string>();
  for (const row of r.rows) {
    try {
      const st = JSON.parse(String(row.stats)) as Partial<TagStats> & { overlap_tried_at?: string };
      triedAt.set(String(row.client_tag).toUpperCase(), String(st.overlap_tried_at ?? st.overlap_at ?? (st.overlap != null ? st.computed_at : "") ?? ""));
    } catch { /* skip */ }
  }
  const cutoff = Date.now() - 20 * 3_600_000;
  const order = [...active]
    .filter((t) => triedAt.has(t.toUpperCase()))                       // only tags that have stats to update
    .filter((t) => { const at = triedAt.get(t.toUpperCase()); return !at || new Date(at).getTime() < cutoff; })
    .sort((a, b) => (triedAt.get(a.toUpperCase()) || "").localeCompare(triedAt.get(b.toUpperCase()) || ""));
  if (!order.length) return { refreshed, skipped: "all fresh" };
  const holder = leaseHolder("tag-overlap");
  if (!(await acquireHeavyLease(holder, LEASE_TTL_MS))) return { refreshed, skipped: "lease busy" };
  try {
    let first = true;
    for (const tag of order) {
      // Only start a tag that can finish (its query may take up to 120s).
      if (Date.now() + 125_000 > opts.finishBy) break;
      if (!first) await new Promise((res) => setTimeout(res, BETWEEN_TAGS_MS));
      first = false;
      if (await dbIsBusy()) return { refreshed, skipped: "database busy" };
      if (!(await renewHeavyLease(holder, LEASE_TTL_MS))) break;
      const { data, error } = await supabase.rpc("nurture_tag_overlap", { p_tag: tag, p_ignore_tags: churned });
      if (error && /function|schema cache/i.test(error.message)) return { refreshed, skipped: "nurture_tag_overlap not installed" };
      const row = await db.execute({ sql: "SELECT stats FROM nurture_tag_stats_cache WHERE client_tag = ?", args: [tag.toUpperCase()] });
      if (!row.rows[0]) continue;
      const st = JSON.parse(String(row.rows[0].stats)) as Record<string, unknown>;
      st.overlap_tried_at = new Date().toISOString();
      if (!error) { st.overlap = Number(data) || 0; st.overlap_at = st.overlap_tried_at; refreshed.push(tag); }
      await db.execute({ sql: "UPDATE nurture_tag_stats_cache SET stats = ? WHERE client_tag = ?", args: [JSON.stringify(st), tag.toUpperCase()] });
    }
  } finally {
    await releaseHeavyLease(holder).catch(() => {});
  }
  return { refreshed };
}

/** Mark a tag's cached numbers as outdated (the next cron run refreshes it first). */
export async function markTagStatsDirty(tag: string): Promise<void> {
  await ensureOverviewTables();
  await db.execute({
    sql: "INSERT INTO nurture_tag_stats_dirty (client_tag, dirty_at) VALUES (?, ?) ON CONFLICT(client_tag) DO UPDATE SET dirty_at = excluded.dirty_at",
    args: [tag.toUpperCase(), new Date().toISOString()],
  });
}

/**
 * "Refresh numbers" for one client, on demand. Skipped if its numbers are
 * under `minGapMs` old; if another heavy query is running it's queued instead
 * (marked dirty → the next cron run, ≤10 min, does it first).
 */
export async function refreshTagStatsNow(tag: string, minGapMs = 60_000): Promise<{ status: "refreshed" | "recent" | "queued" | "failed"; error?: string }> {
  await ensureOverviewTables();
  const r = await db.execute({ sql: "SELECT computed_at FROM nurture_tag_stats_cache WHERE client_tag = ?", args: [tag.toUpperCase()] });
  const at = r.rows[0]?.computed_at ? new Date(String(r.rows[0].computed_at)).getTime() : 0;
  if (Date.now() - at < minGapMs) return { status: "recent" };
  if (!(await lightStatsInstalled())) { await markTagStatsDirty(tag); return { status: "queued" }; }
  const res = await refreshTagStats({ tags: [tag], yieldToLoad: true });
  if (res.busy || res.yielded) { await markTagStatsDirty(tag); return { status: "queued" }; }
  if (res.failed.length) { await markTagStatsDirty(tag); return { status: "failed", error: res.failed[0].error }; }
  return { status: res.refreshed.length ? "refreshed" : "failed", error: res.refreshed.length ? undefined : "unknown client" };
}

// ── Cron work: last contact (newest Sent day per active nurture campaign) ────
async function lastSentDay(instance: string, campaignId: number): Promise<string | null> {
  const { baseUrl, token } = getInstanceConfig(instance);
  const end = new Date(), start = new Date(Date.now() - 13 * 86_400_000);
  const d = (x: Date) => x.toISOString().slice(0, 10);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${baseUrl}/api/campaigns/${campaignId}/line-area-chart-stats?start_date=${d(start)}&end_date=${d(end)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Bison ${res.status}`);
    const j = await res.json() as { data?: Array<{ label?: string; dates?: Array<[string, number]> }> };
    const sent = j.data?.find((s) => String(s.label).toLowerCase() === "sent")?.dates ?? [];
    const hit = [...sent].reverse().find((x) => Number(x[1]) > 0);
    return hit ? String(hit[0]) : null;
  } finally { clearTimeout(t); }
}

/**
 * "Last contact" = newest day each ACTIVE nurture campaign actually sent
 * (Bison line-area-chart, ~1s per campaign). Day precision, so a campaign only
 * needs re-checking every couple of hours: `minAgeMs` skips recently checked
 * ones (keeps the cron to a few thousand light Bison reads a day).
 */
export async function refreshLastContact(opts: { maxCampaigns?: number; maxMs?: number; tag?: string; minAgeMs?: number } = {}): Promise<{ checked: number; failed: number }> {
  await ensureOverviewTables();
  const started = Date.now();
  const { tags } = await activeClientTags();
  const activeSet = new Set(tags.map((t) => t.toUpperCase()));
  const [camps, seen] = await Promise.all([
    db.execute("SELECT id, bison_instance, client_tag, name, status FROM nurture_campaigns_cache WHERE status IN ('active','queued')"),
    db.execute("SELECT campaign_id, bison_instance, checked_at FROM nurture_campaign_last_sent"),
  ]);
  const checkedAt = new Map(seen.rows.map((r) => [`${r.bison_instance}:${r.campaign_id}`, String(r.checked_at || "")]));
  let list = camps.rows
    .filter((r) => isCanonicalNurtureCampaign(String(r.name || "")) && activeSet.has(String(r.client_tag || "").toUpperCase()))
    .filter((r) => !opts.tag || String(r.client_tag).toUpperCase() === opts.tag.toUpperCase())
    .map((r) => ({ id: Number(r.id), instance: String(r.bison_instance), tag: String(r.client_tag).toUpperCase() }))
    .sort((a, b) => (checkedAt.get(`${a.instance}:${a.id}`) || "").localeCompare(checkedAt.get(`${b.instance}:${b.id}`) || ""));
  if (opts.minAgeMs) {
    const cutoff = Date.now() - opts.minAgeMs;
    list = list.filter((c) => { const at = checkedAt.get(`${c.instance}:${c.id}`); return !at || new Date(at).getTime() < cutoff; });
  }
  list = list.slice(0, opts.maxCampaigns ?? list.length);
  let i = 0, checked = 0, failed = 0;
  const worker = async () => {
    while (i < list.length) {
      if (opts.maxMs && Date.now() - started > opts.maxMs) return;
      const c = list[i++];
      try {
        const day = await lastSentDay(c.instance, c.id);
        await db.execute({
          sql: `INSERT INTO nurture_campaign_last_sent (campaign_id, bison_instance, client_tag, last_sent_day, checked_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(campaign_id, bison_instance) DO UPDATE SET client_tag = excluded.client_tag,
                  last_sent_day = COALESCE(excluded.last_sent_day, nurture_campaign_last_sent.last_sent_day), checked_at = excluded.checked_at`,
          args: [c.id, c.instance, c.tag, day, new Date().toISOString()],
        });
        checked++;
      } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return { checked, failed };
}
