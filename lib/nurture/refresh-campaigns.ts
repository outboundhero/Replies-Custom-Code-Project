/**
 * Refresh the Nurture system's copy of every campaign, from all 4 Email Bison instances.
 *
 * Snapshots every "[Nurture]"-named campaign into the Turso `nurture_campaigns_cache`
 * table (and every other client campaign into `main_campaigns_cache`); the Nurture pages
 * read those tables (instant, shared across serverless instances) instead of paginating
 * Bison live on every page load. Then revives completed nurture campaigns and rebuilds
 * the overview.
 *
 * Runs every 10 minutes (/api/cron/refresh-nurture-campaigns) and on demand from the
 * Nurture pages' "Refresh campaigns" button (/api/nurture/refresh-campaigns). One at a
 * time: a run that finds another under way leaves it to that one.
 */
import db from "@/lib/db";
import { listCampaigns } from "@/lib/outboundhero-api";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import { BISON_INSTANCES } from "@/lib/bison-instances";
import { reactivateCompletedNurture } from "@/lib/nurture/reactivate-completed";
import { rebuildOverviewSnapshot } from "@/lib/nurture/overview-snapshot";
import { ensureStageColumns, hasStageColumns } from "@/lib/nurture/stage-columns";

interface Row {
  id: number; uuid: string | null; name: string; status: string; client_tag: string | null; total_leads: number; bison_instance: string;
  contacted: number | null; completion: number | null; replied: number | null;
}
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface CampaignRefreshResult {
  /** Another refresh was already under way (nothing done here). */
  busy?: boolean;
  at: string;
  ms: number;
  /** Nurture campaigns now in the copy. */
  cached: number;
  /** Other client campaigns now in the copy. */
  mains: number;
  /** Instances that couldn't be read (they keep their previous copy). */
  failures?: string[];
  revivedCompleted?: { completed: number; revived: number; skipped: number; failed: number };
}

const LOCK_KEY = "nurture-campaigns-refresh";
const LAST_KEY = "nurture-campaigns-refreshed";
/** Longer than a run may take (its routes allow 300s), so a crashed run never blocks the next for long. */
const LOCK_STALE_MS = 6 * 60_000;

async function ensureState(): Promise<void> {
  await db.execute("CREATE TABLE IF NOT EXISTS cron_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
}
/** Take the one-at-a-time hold; false when another run holds it. */
async function lock(holder: string): Promise<boolean> {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - LOCK_STALE_MS).toISOString();
  const r = await db.execute({
    sql: `INSERT INTO cron_state (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          WHERE cron_state.value = 'idle' OR cron_state.updated_at < ?`,
    args: [LOCK_KEY, holder, now, stale],
  });
  return (r.rowsAffected ?? 0) > 0;
}
async function unlock(holder: string): Promise<void> {
  await db.execute({ sql: "UPDATE cron_state SET value = 'idle', updated_at = ? WHERE key = ? AND value = ?", args: [new Date().toISOString(), LOCK_KEY, holder] }).catch(() => {});
}

/** The last refresh (when, who asked, what it found) and whether one is running now. */
export async function lastCampaignRefresh(): Promise<{ last: (CampaignRefreshResult & { by: string | null; manual: boolean }) | null; running: boolean }> {
  await ensureState();
  const r = await db.execute({ sql: "SELECT key, value, updated_at FROM cron_state WHERE key IN (?, ?)", args: [LOCK_KEY, LAST_KEY] });
  const get = (k: string) => r.rows.find((x) => x.key === k);
  const lk = get(LOCK_KEY);
  const running = !!lk && lk.value !== "idle" && String(lk.updated_at) > new Date(Date.now() - LOCK_STALE_MS).toISOString();
  let last = null;
  try { last = get(LAST_KEY) ? JSON.parse(String(get(LAST_KEY)!.value)) : null; } catch { /* unreadable → none */ }
  return { last, running };
}

export async function refreshNurtureCampaigns(opts: { by?: string | null; manual?: boolean } = {}): Promise<CampaignRefreshResult> {
  const t0 = Date.now();
  await ensureState();
  const holder = crypto.randomUUID();
  if (!(await lock(holder))) return { busy: true, at: new Date().toISOString(), ms: 0, cached: 0, mains: 0 };
  try {
    // Pull every campaign from every instance (allSettled so one bad instance doesn't sink the snapshot).
    // strict: a failed page fails that instance (its cached rows are kept) instead of silently dropping campaigns.
    const settled = await Promise.allSettled(BISON_INSTANCES.map((i) => listCampaigns(i.key, { strict: true })));
    const rows: Row[] = [];
    const failures: string[] = [];
    settled.forEach((s, idx) => {
      const key = BISON_INSTANCES[idx].key;
      if (s.status === "fulfilled") {
        for (const c of s.value) {
          if (!/\bnurture\b/i.test(c.name || "")) continue;
          rows.push({
            id: c.id, uuid: c.uuid ?? null, name: c.name, status: c.status,
            client_tag: extractTagFromCampaignName(c.name) || null,
            total_leads: c.total_leads ?? 0, bison_instance: key,
            contacted: num(c.total_leads_contacted), completion: num(c.completion_percentage), replied: num(c.unique_replies ?? c.replied),
          });
        }
      } else failures.push(`${key}: ${(s.reason as Error)?.message || "unknown"}`);
    });

    await db.execute(
      `CREATE TABLE IF NOT EXISTS nurture_campaigns_cache (
        id INTEGER, uuid TEXT, name TEXT, status TEXT, client_tag TEXT,
        total_leads INTEGER, bison_instance TEXT, synced_at TEXT,
        PRIMARY KEY (id, bison_instance)
      )`,
    );
    await db.execute(
      `CREATE TABLE IF NOT EXISTS main_campaigns_cache (
        id INTEGER, bison_instance TEXT, client_tag TEXT, name TEXT, status TEXT,
        total_leads INTEGER, synced_at TEXT, PRIMARY KEY (id, bison_instance)
      )`,
    ).catch((e) => console.error("[refresh-nurture-campaigns] main-campaign table:", (e as Error).message));
    // Progress columns ("where contacts sit"): contacted, completion, replies. Never let them
    // stop the refresh — without them the rows are written the way they always were.
    const progress = await ensureStageColumns().then(() => hasStageColumns()).catch((e) => {
      console.error("[refresh-nurture-campaigns] progress columns unavailable:", (e as Error).message);
      return false;
    });

    // Replace ONLY the instances that answered (a failed instance keeps its last
    // rows), each in one transaction so a reader never sees a half-filled cache.
    {
      const now = new Date().toISOString();
      for (let idx = 0; idx < settled.length; idx++) {
        if (settled[idx].status !== "fulfilled") continue;
        const key = BISON_INSTANCES[idx].key;
        const mine = rows.filter((r) => r.bison_instance === key);
        await db.batch([
          { sql: "DELETE FROM nurture_campaigns_cache WHERE bison_instance = ?", args: [key] },
          ...mine.map((r) => (progress ? {
            sql: "INSERT OR REPLACE INTO nurture_campaigns_cache (id, uuid, name, status, client_tag, total_leads, bison_instance, synced_at, contacted, completion, replied) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            args: [r.id, r.uuid, r.name, r.status, r.client_tag, r.total_leads, r.bison_instance, now, r.contacted, r.completion, r.replied],
          } : {
            sql: "INSERT OR REPLACE INTO nurture_campaigns_cache (id, uuid, name, status, client_tag, total_leads, bison_instance, synced_at) VALUES (?,?,?,?,?,?,?,?)",
            args: [r.id, r.uuid, r.name, r.status, r.client_tag, r.total_leads, r.bison_instance, now],
          })),
        ], "write");
      }
    }

    // Also snapshot every tagged NON-nurture ("main") campaign — the Nurture
    // overview shows active main campaigns per client tag. Same lists as above,
    // so no extra Bison calls. Replaced per instance only when that instance's
    // list came back (a failed instance keeps its previous snapshot).
    let mainCount = 0;
    try {
      const now = new Date().toISOString();
      for (let idx = 0; idx < settled.length; idx++) {
        const s = settled[idx];
        if (s.status !== "fulfilled") continue;
        const key = BISON_INSTANCES[idx].key;
        const mains = s.value
          .filter((c) => !/\bnurture\b/i.test(c.name || ""))
          .map((c) => ({ c, tag: extractTagFromCampaignName(c.name) }))
          .filter((x) => !!x.tag);
        mainCount += mains.length;
        // One transaction per instance (same reason as above).
        await db.batch([
          { sql: "DELETE FROM main_campaigns_cache WHERE bison_instance = ?", args: [key] },
          ...mains.map(({ c, tag }) => (progress ? {
            sql: "INSERT OR REPLACE INTO main_campaigns_cache (id, bison_instance, client_tag, name, status, total_leads, synced_at, contacted, completion, replied) VALUES (?,?,?,?,?,?,?,?,?,?)",
            args: [c.id, key, tag, c.name, c.status, c.total_leads ?? 0, now, num(c.total_leads_contacted), num(c.completion_percentage), num(c.unique_replies ?? c.replied)],
          } : {
            sql: "INSERT OR REPLACE INTO main_campaigns_cache (id, bison_instance, client_tag, name, status, total_leads, synced_at) VALUES (?,?,?,?,?,?,?)",
            args: [c.id, key, tag, c.name, c.status, c.total_leads ?? 0, now],
          })),
        ], "write");
      }
    } catch (e) {
      console.error("[refresh-nurture-campaigns] main-campaign snapshot failed:", (e as Error).message);
    }

    // Revive any nurture campaigns that have gone "completed" (Bison stops them,
    // silently killing nurture for the client). Reuse the lists we already paged
    // above so this adds no extra Bison list calls. Never let it sink the refresh.
    let revived: Awaited<ReturnType<typeof reactivateCompletedNurture>> | undefined;
    try {
      const campaignsByInstance: Record<string, typeof rows[number][]> = {};
      settled.forEach((s, idx) => {
        if (s.status === "fulfilled") {
          campaignsByInstance[BISON_INSTANCES[idx].key] = s.value as unknown as typeof rows[number][];
        }
      });
      revived = await reactivateCompletedNurture({ campaignsByInstance });
    } catch (e) {
      console.error("[refresh-nurture-campaigns] revive-completed failed:", (e as Error).message);
    }

    // The Nurture pages read a precomputed overview — refresh it with the new
    // campaign snapshot. Never let it sink the refresh.
    try { await rebuildOverviewSnapshot(); } catch (e) {
      console.error("[refresh-nurture-campaigns] overview snapshot failed:", (e as Error).message);
    }

    const result: CampaignRefreshResult = {
      at: new Date().toISOString(), ms: Date.now() - t0, cached: rows.length, mains: mainCount,
      failures: failures.length ? failures : undefined,
      revivedCompleted: revived ? { completed: revived.completed, revived: revived.revived, skipped: revived.skipped, failed: revived.failed } : undefined,
    };
    await db.execute({
      sql: "INSERT INTO cron_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      args: [LAST_KEY, JSON.stringify({ ...result, by: opts.by ?? null, manual: !!opts.manual }), result.at],
    }).catch(() => {});
    return result;
  } finally {
    await unlock(holder);
  }
}
