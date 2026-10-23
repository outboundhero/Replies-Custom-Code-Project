/**
 * A client's Hard Reset or Nurture reset — durable state (Turso `hard_reset`, one row per reset).
 *
 *   kind "hard"     all 12 campaigns made fresh; every current campaign archived
 *   kind "nurture"  only the 6 nurture campaigns made fresh (main campaigns untouched); the client's
 *                   queue emptied ("emptying"); the old nurture campaigns archived
 *
 * Status flow (the order matters: the client keeps running on its old
 * campaigns until the new ones are fully set up, and archiving — which Email
 * Bison can't undo — comes last):
 *   creating → attaching → repointing → [emptying →] archiving → done
 *   failed      stopped in a step (`failed_step`); "Try again" resumes it there
 *   cancelling → cancelled   (only before archiving starts: the new campaigns are deleted)
 * One open reset per client (a partial unique index); one runs at a time (a lease).
 */
import db from "@/lib/db";

export type ResetKind = "hard" | "nurture";
export type ResetStatus = "creating" | "attaching" | "repointing" | "emptying" | "archiving" | "done" | "failed" | "cancelling" | "cancelled";
export const WORKING: ResetStatus[] = ["creating", "attaching", "repointing", "emptying", "archiving", "cancelling"];
/** Steps a reset can still be cancelled in: before nurture is switched (nothing of the client's has changed yet). */
export const CANCELLABLE: ResetStatus[] = ["creating", "attaching"];

/** A campaign the reset archives — frozen when it starts (`late`: made since, found by the last check before archiving). */
export interface OldCampaign { instance: string; id: number; name: string; status: string; leads: number; late?: boolean }
/**
 * One build result (the same shape onboarding's campaign step records — its planner reads it back).
 * "building" = saved just before a build starts; one still there later was cut off part-way.
 */
export interface BuildRecord {
  instance: string; name: string; state: "created" | "failed" | "building"; campaignId: number | null; note: string; unsure: boolean; at: string; lines: Record<string, string>;
  /** A failed try whose leftover draft has been dealt with (deleted, or none found) — not looked at again. */
  cleared?: boolean;
}
/** Inboxes to attach in one instance, and how far each new campaign has got. */
export interface AttachState {
  tagId: number | null;
  senders: number[] | null;
  campaigns: Record<string, { attached: number; refused: number[]; verified: boolean; total: number | null }>;
  /** Of `senders`, the ones not Connected when read (Email Bison may refuse those; they don't count against the run). */
  offline?: number[];
  /** Tagged inboxes left out because they're also marked Reserve / Burnt (released domains keep old client tags). */
  setAside?: number;
}
export interface ArchiveRecord { instance: string; id: number; name: string; result: "archived" | "already" | "gone" | "skipped"; note?: string; at: string }
/** A Nurture reset emptying the client's queue: one removal ("Remove all") — or one per source when it's very big. */
export interface EmptyQueueState {
  /** Contacts waiting when it started. */
  total: number | null;
  /** Over the per-removal limit, so removed source by source (decided once). */
  split: boolean | null;
  removals: Array<{ source: string | null; removalId: number | null; contacts: number; rows: number }>;
  /** Removals a run that died mid-way left unrecorded (they may have gone through, without Undo). */
  interrupted?: number;
  done: boolean;
}

export interface HardReset {
  id: number; clientTag: string; kind: ResetKind; status: ResetStatus; failedStep: ResetStatus | null;
  params: Record<string, unknown>;
  client: {
    group: 1 | 2; b2b: string; b2c: string; plan: string | null; name: string | null; timezone: string | null;
    /** Working inboxes per instance when the preview was approved — the run stops if it later finds far fewer. */
    inboxes?: Record<string, number>;
    /** Nurture reset: the main campaigns it keeps ("instance:id"), planned around. */
    keep?: string[];
  };
  archive: OldCampaign[];
  built: BuildRecord[];
  attach: Record<string, AttachState>;
  nurture: { before: unknown[]; batches: unknown[]; after: unknown[] } | null;
  archived: ArchiveRecord[];
  /** Nurture reset: how the queue was emptied (kept in the requeue_json column). */
  emptied: EmptyQueueState | null;
  /** Set once the last check before archiving passed (new campaigns + inboxes + nurture in place, late campaigns added). */
  precheckedAt: string | null;
  attempts: number; error: string | null;
  createdBy: string | null; createdAt: string; updatedAt: string; finishedAt: string | null;
  leaseHolder: string | null; heartbeatAt: string | null;
}

const nowIso = () => new Date().toISOString();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const json = <T>(v: unknown, d: T): T => { try { return v == null ? d : JSON.parse(String(v)) as T; } catch { return d; } };

let ready: Promise<void> | null = null;
export function ensureTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await db.execute(`CREATE TABLE IF NOT EXISTS hard_reset (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_tag TEXT NOT NULL,
        status TEXT NOT NULL,
        failed_step TEXT,
        params_json TEXT NOT NULL,
        client_json TEXT NOT NULL,
        archive_json TEXT NOT NULL,
        built_json TEXT NOT NULL DEFAULT '[]',
        attach_json TEXT NOT NULL DEFAULT '{}',
        nurture_json TEXT,
        archived_json TEXT NOT NULL DEFAULT '[]',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
        lease_holder TEXT, heartbeat_at TEXT
      )`);
      for (const col of ["prechecked_at TEXT", "kind TEXT NOT NULL DEFAULT 'hard'", "requeue_json TEXT"]) {
        try { await db.execute(`ALTER TABLE hard_reset ADD COLUMN ${col}`); } catch { /* already there */ }
      }
      await db.execute("CREATE INDEX IF NOT EXISTS idx_hard_reset_tag ON hard_reset(client_tag, id)");
      // One open reset per client, even if two people start one at the same moment.
      await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_hard_reset_one_open ON hard_reset(client_tag) WHERE status NOT IN ('done', 'cancelled')");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

function toReset(r: Row): HardReset {
  return {
    id: Number(r.id), clientTag: String(r.client_tag), kind: r.kind === "nurture" ? "nurture" : "hard", status: String(r.status) as ResetStatus, failedStep: (r.failed_step as ResetStatus) ?? null,
    params: json(r.params_json, {}), client: json(r.client_json, { group: 1, b2b: "", b2c: "", plan: null, name: null, timezone: null }),
    archive: json(r.archive_json, []), built: json(r.built_json, []), attach: json(r.attach_json, {}),
    nurture: json(r.nurture_json, null), archived: json(r.archived_json, []), emptied: json(r.requeue_json, null), precheckedAt: r.prechecked_at ?? null,
    attempts: Number(r.attempts) || 0, error: r.error ?? null,
    createdBy: r.created_by ?? null, createdAt: String(r.created_at), updatedAt: String(r.updated_at), finishedAt: r.finished_at ?? null,
    leaseHolder: r.lease_holder ?? null, heartbeatAt: r.heartbeat_at ?? null,
  };
}

export async function getReset(id: number): Promise<HardReset | null> {
  await ensureTables();
  const r = await db.execute({ sql: "SELECT * FROM hard_reset WHERE id = ?", args: [id] });
  return r.rows.length ? toReset(r.rows[0] as Row) : null;
}

/** The client's latest reset (any status). */
export async function latestReset(clientTag: string): Promise<HardReset | null> {
  await ensureTables();
  const r = await db.execute({ sql: "SELECT * FROM hard_reset WHERE client_tag = ? ORDER BY id DESC LIMIT 1", args: [clientTag.toUpperCase()] });
  return r.rows.length ? toReset(r.rows[0] as Row) : null;
}

/** Record a new reset, ready to run. Throws "UNIQUE" when the client already has an open one. */
export async function createReset(input: { clientTag: string; kind?: ResetKind; params: Record<string, unknown>; client: HardReset["client"]; archive: OldCampaign[]; by: string | null }): Promise<number> {
  await ensureTables();
  const now = nowIso();
  const r = await db.execute({
    sql: `INSERT INTO hard_reset (client_tag, kind, status, params_json, client_json, archive_json, created_by, created_at, updated_at)
          VALUES (?, ?, 'creating', ?, ?, ?, ?, ?, ?) RETURNING id`,
    args: [input.clientTag.toUpperCase(), input.kind ?? "hard", JSON.stringify(input.params), JSON.stringify(input.client), JSON.stringify(input.archive), input.by, now, now],
  });
  return Number(r.rows[0]?.id);
}

/**
 * Update fields, optionally only from the given statuses (and, for a stopped reset, only if it
 * stopped in `failedStep`) and only while `holder` holds the lease. True when a row changed.
 */
export async function patchReset(id: number, fields: Record<string, unknown>, opts: { from?: ResetStatus[]; failedStep?: ResetStatus | null; holder?: string } = {}): Promise<boolean> {
  const keys = Object.keys(fields);
  const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
  const where = [
    "id = ?",
    ...(opts.from?.length ? [`status IN (${opts.from.map(() => "?").join(",")})`] : []),
    ...(opts.failedStep !== undefined ? ["COALESCE(failed_step, '') = ?"] : []),
    ...(opts.holder ? ["lease_holder = ?"] : []),
  ].join(" AND ");
  const r = await db.execute({
    sql: `UPDATE hard_reset SET ${sets} WHERE ${where}`,
    args: [
      ...keys.map((k) => { const v = fields[k]; return (typeof v === "object" && v !== null ? JSON.stringify(v) : v) as string | number | null; }),
      nowIso(), id, ...(opts.from ?? []), ...(opts.failedStep !== undefined ? [opts.failedStep ?? ""] : []), ...(opts.holder ? [opts.holder] : []),
    ],
  });
  return (r.rowsAffected ?? 0) > 0;
}

// ── lease: one runner at a time across all resets ────────────────────────────

/** Longer than a function may live (the cron route's maxDuration is 300s), so a slow step can never overlap a second runner. */
export const LEASE_STALE_MS = 330_000;

export class LeaseLost extends Error {
  constructor(id: number) { super(`Lost the hold on hard reset #${id}`); this.name = "LeaseLost"; }
}

export async function leaseReset(id?: number): Promise<HardReset | null> {
  await ensureTables();
  const now = nowIso();
  const stale = new Date(Date.now() - LEASE_STALE_MS).toISOString();
  const working = `status IN (${WORKING.map(() => "?").join(",")})`;
  const free = "(heartbeat_at IS NULL OR heartbeat_at < ?)";
  const pick = id
    ? await db.execute({ sql: `SELECT id FROM hard_reset WHERE id = ? AND ${working} AND ${free}`, args: [id, ...WORKING, stale] })
    : await db.execute({ sql: `SELECT id FROM hard_reset WHERE ${working} AND ${free} ORDER BY id LIMIT 1`, args: [...WORKING, stale] });
  if (!pick.rows.length) return null;
  const rid = Number(pick.rows[0].id);
  const holder = crypto.randomUUID();
  const claim = await db.execute({
    sql: `UPDATE hard_reset SET lease_holder = ?, heartbeat_at = ? WHERE id = ? AND ${free}
            AND NOT EXISTS (SELECT 1 FROM hard_reset x WHERE x.id <> ? AND x.heartbeat_at IS NOT NULL AND x.heartbeat_at >= ?)`,
    args: [holder, now, rid, stale, rid, stale],
  });
  if (!(claim.rowsAffected ?? 0)) return null;
  const r = await getReset(rid);
  return r && r.leaseHolder === holder ? r : null;
}

export async function heartbeat(id: number, holder: string): Promise<void> {
  const r = await db.execute({ sql: "UPDATE hard_reset SET heartbeat_at = ? WHERE id = ? AND lease_holder = ?", args: [nowIso(), id, holder] });
  if (!(r.rowsAffected ?? 0)) throw new LeaseLost(id);
}

export async function releaseLease(id: number, holder: string): Promise<void> {
  await db.execute({ sql: "UPDATE hard_reset SET lease_holder = NULL, heartbeat_at = NULL WHERE id = ? AND lease_holder = ?", args: [id, holder] });
}
