/**
 * Costing storage (docs/costing-feed-spec.md §8), in Reply Router's own Turso database — never
 * the shared inbox database. Every line item is kept permanently, keyed by product + item id,
 * with its amount both as sent and as an exact count of 1e-12 units. Every change a re-pull makes
 * (amount, status, any field, or an item the product no longer reports) goes to costing_change.
 */
import { randomUUID } from "crypto";
import db from "@/lib/db";
import type { CleanItem } from "./validate";

export const MANUAL_PID = "manual";

export interface ProductRow {
  pid: string;
  slug: string | null;
  name: string;
  base_url: string | null;
  key_hint: string | null;
  environment: string | null;
  notes: string | null;
  kind: "feed" | "manual";
  enabled: boolean;
  created_at: string;
  last_pull_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  last_generated_at: string | null;
}

export interface StoredItem {
  pid: string;
  item_id: string;
  date: string;
  category: string;
  vendor: string;
  service: string | null;
  model: string | null;
  description: string | null;
  billing_type: string;
  amount: string;
  units: string;
  currency: string;
  source: string;
  status: "final" | "pending";
  invoice_id: string | null;
  invoice_url: string | null;
  extra: string | null;
  first_seen_at: string;
  updated_at: string;
}

let ready: Promise<void> | null = null;
export function ensureCostingTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await db.batch([
        `CREATE TABLE IF NOT EXISTS costing_product (
           pid TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT NOT NULL, base_url TEXT,
           key_sealed TEXT, key_hint TEXT, environment TEXT, notes TEXT,
           kind TEXT NOT NULL DEFAULT 'feed', enabled INTEGER NOT NULL DEFAULT 1,
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
           last_pull_at TEXT, last_ok_at TEXT, last_error TEXT, last_error_at TEXT, last_generated_at TEXT)`,
        `CREATE TABLE IF NOT EXISTS costing_item (
           pid TEXT NOT NULL, item_id TEXT NOT NULL, date TEXT NOT NULL,
           category TEXT NOT NULL, vendor TEXT NOT NULL, service TEXT, model TEXT, description TEXT,
           billing_type TEXT NOT NULL, amount TEXT NOT NULL, units TEXT NOT NULL, currency TEXT NOT NULL,
           source TEXT NOT NULL, status TEXT NOT NULL, invoice_id TEXT, invoice_url TEXT, extra TEXT,
           first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL,
           PRIMARY KEY (pid, item_id))`,
        "CREATE INDEX IF NOT EXISTS idx_costing_item_date ON costing_item(date)",
        "CREATE INDEX IF NOT EXISTS idx_costing_item_pid_date ON costing_item(pid, date)",
        `CREATE TABLE IF NOT EXISTS costing_change (
           id INTEGER PRIMARY KEY AUTOINCREMENT, pid TEXT NOT NULL, item_id TEXT NOT NULL,
           at TEXT NOT NULL, kind TEXT NOT NULL, before TEXT, after TEXT)`,
        "CREATE INDEX IF NOT EXISTS idx_costing_change_pid_at ON costing_change(pid, at)",
        `CREATE TABLE IF NOT EXISTS costing_pull (
           id INTEGER PRIMARY KEY AUTOINCREMENT, pid TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
           ok INTEGER, range_from TEXT, range_to TEXT, added INTEGER, changed INTEGER, removed INTEGER,
           unchanged INTEGER, error TEXT, trigger TEXT)`,
        "CREATE INDEX IF NOT EXISTS idx_costing_pull_pid ON costing_pull(pid, started_at)",
      ], "write");
      // Costs for tools no product reports (spec has no home for them) are added by hand here.
      const now = new Date().toISOString();
      await db.execute({
        sql: `INSERT OR IGNORE INTO costing_product (pid, slug, name, kind, enabled, created_at, updated_at)
              VALUES (?, 'added-by-hand', 'Added by hand', 'manual', 1, ?, ?)`,
        args: [MANUAL_PID, now, now],
      });
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const toProduct = (r: Record<string, unknown>): ProductRow => ({
  pid: String(r.pid), slug: r.slug ? String(r.slug) : null, name: String(r.name),
  base_url: r.base_url ? String(r.base_url) : null, key_hint: r.key_hint ? String(r.key_hint) : null,
  environment: r.environment ? String(r.environment) : null, notes: r.notes ? String(r.notes) : null,
  kind: r.kind === "manual" ? "manual" : "feed", enabled: Number(r.enabled) === 1,
  created_at: String(r.created_at),
  last_pull_at: (r.last_pull_at as string) ?? null, last_ok_at: (r.last_ok_at as string) ?? null,
  last_error: (r.last_error as string) ?? null, last_error_at: (r.last_error_at as string) ?? null,
  last_generated_at: (r.last_generated_at as string) ?? null,
});

export async function listProducts(): Promise<ProductRow[]> {
  await ensureCostingTables();
  const r = await db.execute("SELECT * FROM costing_product ORDER BY kind DESC, name COLLATE NOCASE");
  return r.rows.map((x) => toProduct(x as Record<string, unknown>));
}

/** Server-only: includes the sealed key. */
export async function getProductWithKey(pid: string): Promise<(ProductRow & { key_sealed: string | null }) | null> {
  await ensureCostingTables();
  const r = await db.execute({ sql: "SELECT * FROM costing_product WHERE pid = ?", args: [pid] });
  const row = r.rows[0] as Record<string, unknown> | undefined;
  return row ? { ...toProduct(row), key_sealed: (row.key_sealed as string) ?? null } : null;
}

export async function addProduct(p: { name: string; baseUrl: string; keySealed: string; keyHint: string }): Promise<string> {
  await ensureCostingTables();
  const pid = randomUUID(), now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO costing_product (pid, name, base_url, key_sealed, key_hint, kind, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'feed', 1, ?, ?)`,
    args: [pid, p.name, p.baseUrl, p.keySealed, p.keyHint, now, now],
  });
  return pid;
}

export async function updateProduct(pid: string, p: { name?: string; baseUrl?: string; keySealed?: string; keyHint?: string; enabled?: boolean }): Promise<void> {
  const sets: string[] = [], args: (string | number)[] = [];
  if (p.name !== undefined) { sets.push("name = ?"); args.push(p.name); }
  if (p.baseUrl !== undefined) { sets.push("base_url = ?"); args.push(p.baseUrl); }
  if (p.keySealed !== undefined) { sets.push("key_sealed = ?", "key_hint = ?"); args.push(p.keySealed, p.keyHint ?? ""); }
  if (p.enabled !== undefined) { sets.push("enabled = ?"); args.push(p.enabled ? 1 : 0); }
  if (!sets.length) return;
  sets.push("updated_at = ?"); args.push(new Date().toISOString(), pid);
  await db.execute({ sql: `UPDATE costing_product SET ${sets.join(", ")} WHERE pid = ? AND kind = 'feed'`, args });
}

/** Only a product that has never stored a figure can be deleted — stored figures are permanent. */
export async function deleteProductIfEmpty(pid: string): Promise<boolean> {
  const has = await db.execute({ sql: "SELECT 1 FROM costing_item WHERE pid = ? LIMIT 1", args: [pid] });
  if (has.rows.length) return false;
  await db.batch([
    { sql: "DELETE FROM costing_pull WHERE pid = ?", args: [pid] },
    { sql: "DELETE FROM costing_product WHERE pid = ? AND kind = 'feed'", args: [pid] },
  ], "write");
  return true;
}

export async function slugTakenBy(slug: string, exceptPid: string): Promise<string | null> {
  const r = await db.execute({ sql: "SELECT name FROM costing_product WHERE slug = ? AND pid != ?", args: [slug, exceptPid] });
  return r.rows[0] ? String(r.rows[0].name) : null;
}

export async function markPullResult(pid: string, r: { ok: boolean; error?: string; feedMeta?: { slug: string; name: string; environment: string; notes: string | null; generatedAt: string } }): Promise<void> {
  const now = new Date().toISOString();
  if (r.ok && r.feedMeta) {
    await db.execute({
      sql: `UPDATE costing_product SET slug = ?, name = ?, environment = ?, notes = ?, last_generated_at = ?,
              last_pull_at = ?, last_ok_at = ?, last_error = NULL, last_error_at = NULL, updated_at = ? WHERE pid = ?`,
      args: [r.feedMeta.slug, r.feedMeta.name, r.feedMeta.environment, r.feedMeta.notes, r.feedMeta.generatedAt, now, now, now, pid],
    });
  } else {
    await db.execute({
      sql: "UPDATE costing_product SET last_pull_at = ?, last_error = ?, last_error_at = ?, updated_at = ? WHERE pid = ?",
      args: [now, (r.error ?? "Unknown error").slice(0, 4000), now, now, pid],
    });
  }
}

export async function recordPull(row: { pid: string; startedAt: string; ok: boolean; from: string; to: string; added?: number; changed?: number; removed?: number; unchanged?: number; error?: string; trigger: string }): Promise<void> {
  await db.execute({
    sql: `INSERT INTO costing_pull (pid, started_at, finished_at, ok, range_from, range_to, added, changed, removed, unchanged, error, trigger)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [row.pid, row.startedAt, new Date().toISOString(), row.ok ? 1 : 0, row.from, row.to,
      row.added ?? 0, row.changed ?? 0, row.removed ?? 0, row.unchanged ?? 0, row.error ? row.error.slice(0, 4000) : null, row.trigger],
  });
}

/** The oldest date this product still has a pending figure for (re-pulled until it turns final). */
export async function oldestPendingDate(pid: string): Promise<string | null> {
  const r = await db.execute({ sql: "SELECT MIN(date) AS d FROM costing_item WHERE pid = ? AND status = 'pending'", args: [pid] });
  return r.rows[0]?.d ? String(r.rows[0].d) : null;
}

// ── Applying a validated feed ────────────────────────────────────────────────

const FIELDS = ["date", "category", "vendor", "service", "model", "description", "billing_type", "amount", "units", "currency", "source", "status", "invoice_id", "invoice_url", "extra"] as const;
type Snapshot = Record<(typeof FIELDS)[number], string | null>;

function snapshotOf(i: CleanItem): Snapshot {
  return {
    date: i.date, category: i.category, vendor: i.vendor, service: i.service, model: i.model, description: i.description,
    billing_type: i.billing_type, amount: i.amount, units: i.units.toString(), currency: i.currency, source: i.source,
    status: i.status, invoice_id: i.invoice_id, invoice_url: i.invoice_url,
    extra: Object.keys(i.extra).length ? JSON.stringify(i.extra) : null,
  };
}
const snapshotOfRow = (r: Record<string, unknown>): Snapshot =>
  Object.fromEntries(FIELDS.map((f) => [f, r[f] == null ? null : String(r[f])])) as Snapshot;

/** Fields that differ — amounts compared exactly ("20.0" and "20.00" are the same amount). */
function diff(before: Snapshot, after: Snapshot): string[] {
  return FIELDS.filter((f) => f !== "amount" && (f === "units" ? before.units !== after.units : before[f] !== after[f]));
}

export interface ApplyResult { added: number; changed: number; removed: number; unchanged: number }

/**
 * Makes the stored items of one product for [from, to] exactly what the feed says: new items are
 * added, changed ones updated, and items the product no longer reports for that range are removed
 * (a regrouped or corrected feed must not be counted twice). Every change is logged.
 */
export async function applyRange(pid: string, from: string, to: string, items: CleanItem[]): Promise<ApplyResult> {
  const now = new Date().toISOString();
  const existing = new Map<string, Record<string, unknown>>();
  const inRange = await db.execute({ sql: "SELECT * FROM costing_item WHERE pid = ? AND date >= ? AND date <= ?", args: [pid, from, to] });
  for (const r of inRange.rows) existing.set(String(r.item_id), r as Record<string, unknown>);
  // Items whose date moved into this range from elsewhere.
  const missing = items.map((i) => i.id).filter((id) => !existing.has(id));
  for (let k = 0; k < missing.length; k += 200) {
    const part = missing.slice(k, k + 200);
    const r = await db.execute({ sql: `SELECT * FROM costing_item WHERE pid = ? AND item_id IN (${part.map(() => "?").join(",")})`, args: [pid, ...part] });
    for (const row of r.rows) existing.set(String(row.item_id), row as Record<string, unknown>);
  }

  const stmts: { sql: string; args: (string | null)[] }[] = [];
  const res: ApplyResult = { added: 0, changed: 0, removed: 0, unchanged: 0 };
  const reported = new Set<string>();
  for (const it of items) {
    reported.add(it.id);
    const after = snapshotOf(it);
    const prev = existing.get(it.id);
    if (!prev) {
      res.added++;
      stmts.push({
        sql: `INSERT INTO costing_item (pid, item_id, ${FIELDS.join(", ")}, first_seen_at, updated_at)
              VALUES (?, ?, ${FIELDS.map(() => "?").join(", ")}, ?, ?)`,
        args: [pid, it.id, ...FIELDS.map((f) => after[f]), now, now],
      });
      continue;
    }
    const before = snapshotOfRow(prev);
    const changedFields = diff(before, after);
    if (!changedFields.length) { res.unchanged++; continue; }
    res.changed++;
    stmts.push({
      sql: `UPDATE costing_item SET ${FIELDS.map((f) => `${f} = ?`).join(", ")}, updated_at = ? WHERE pid = ? AND item_id = ?`,
      args: [...FIELDS.map((f) => after[f]), now, pid, it.id],
    });
    const pick = (s: Snapshot) => Object.fromEntries(["amount", "status", ...changedFields.filter((f) => f !== "units")].map((f) => [f, s[f as keyof Snapshot]]));
    stmts.push({
      sql: "INSERT INTO costing_change (pid, item_id, at, kind, before, after) VALUES (?, ?, ?, 'changed', ?, ?)",
      args: [pid, it.id, now, JSON.stringify(pick(before)), JSON.stringify(pick(after))],
    });
  }
  for (const [id, row] of existing) {
    const d = String(row.date);
    if (reported.has(id) || d < from || d > to) continue;
    res.removed++;
    stmts.push({ sql: "DELETE FROM costing_item WHERE pid = ? AND item_id = ?", args: [pid, id] });
    stmts.push({
      sql: "INSERT INTO costing_change (pid, item_id, at, kind, before, after) VALUES (?, ?, ?, 'removed', ?, NULL)",
      args: [pid, id, now, JSON.stringify({ amount: row.amount, status: row.status, currency: row.currency, date: row.date, vendor: row.vendor, category: row.category, description: row.description })],
    });
  }
  for (let k = 0; k < stmts.length; k += 300) await db.batch(stmts.slice(k, k + 300), "write");
  return res;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export async function itemsBetween(from: string, to: string): Promise<StoredItem[]> {
  await ensureCostingTables();
  const r = await db.execute({
    sql: `SELECT i.* FROM costing_item i JOIN costing_product p ON p.pid = i.pid
          WHERE i.date >= ? AND i.date <= ? ORDER BY i.date DESC, i.pid, i.item_id`,
    args: [from, to],
  });
  return r.rows.map((x) => ({ ...(x as unknown as StoredItem) }));
}

export async function itemStats(): Promise<Map<string, { items: number; first: string | null; last: string | null }>> {
  await ensureCostingTables();
  const r = await db.execute("SELECT pid, COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM costing_item GROUP BY pid");
  return new Map(r.rows.map((x) => [String(x.pid), { items: Number(x.n), first: (x.first as string) ?? null, last: (x.last as string) ?? null }]));
}

export async function listChanges(pid: string | null, limit = 200): Promise<Array<{ pid: string; item_id: string; at: string; kind: string; before: unknown; after: unknown }>> {
  await ensureCostingTables();
  const r = await db.execute({
    sql: `SELECT pid, item_id, at, kind, before, after FROM costing_change ${pid ? "WHERE pid = ?" : ""} ORDER BY id DESC LIMIT ?`,
    args: pid ? [pid, limit] : [limit],
  });
  const parse = (v: unknown) => { try { return v ? JSON.parse(String(v)) : null; } catch { return null; } };
  return r.rows.map((x) => ({ pid: String(x.pid), item_id: String(x.item_id), at: String(x.at), kind: String(x.kind), before: parse(x.before), after: parse(x.after) }));
}

export async function recentPulls(limit = 50): Promise<Array<Record<string, unknown>>> {
  await ensureCostingTables();
  const r = await db.execute({ sql: "SELECT * FROM costing_pull ORDER BY id DESC LIMIT ?", args: [limit] });
  return r.rows.map((x) => ({ ...(x as Record<string, unknown>) }));
}

// ── Added by hand ────────────────────────────────────────────────────────────

/** Adds (existingId null) or edits a cost entered by hand. Edits are logged like feed changes. */
export async function saveManualItem(item: CleanItem, existingId: string | null): Promise<string> {
  await ensureCostingTables();
  const now = new Date().toISOString();
  const id = existingId ?? `manual:${randomUUID()}`;
  const after = snapshotOf({ ...item, id });
  if (!existingId) {
    await db.batch([
      { sql: `INSERT INTO costing_item (pid, item_id, ${FIELDS.join(", ")}, first_seen_at, updated_at) VALUES (?, ?, ${FIELDS.map(() => "?").join(", ")}, ?, ?)`,
        args: [MANUAL_PID, id, ...FIELDS.map((f) => after[f]), now, now] },
      { sql: "INSERT INTO costing_change (pid, item_id, at, kind, before, after) VALUES (?, ?, ?, 'added', NULL, ?)",
        args: [MANUAL_PID, id, now, JSON.stringify({ amount: after.amount, status: after.status, currency: after.currency, date: after.date, vendor: after.vendor })] },
    ], "write");
    return id;
  }
  const prev = await db.execute({ sql: "SELECT * FROM costing_item WHERE pid = ? AND item_id = ?", args: [MANUAL_PID, id] });
  if (!prev.rows[0]) throw new Error("That cost no longer exists.");
  const before = snapshotOfRow(prev.rows[0] as Record<string, unknown>);
  const changedFields = diff(before, after);
  if (!changedFields.length) return id;
  const pick = (s: Snapshot) => Object.fromEntries(["amount", "status", ...changedFields.filter((f) => f !== "units")].map((f) => [f, s[f as keyof Snapshot]]));
  await db.batch([
    { sql: `UPDATE costing_item SET ${FIELDS.map((f) => `${f} = ?`).join(", ")}, updated_at = ? WHERE pid = ? AND item_id = ?`,
      args: [...FIELDS.map((f) => after[f]), now, MANUAL_PID, id] },
    { sql: "INSERT INTO costing_change (pid, item_id, at, kind, before, after) VALUES (?, ?, ?, 'changed', ?, ?)",
      args: [MANUAL_PID, id, now, JSON.stringify(pick(before)), JSON.stringify(pick(after))] },
  ], "write");
  return id;
}

export async function deleteManualItem(itemId: string): Promise<boolean> {
  await ensureCostingTables();
  const r = await db.execute({ sql: "SELECT * FROM costing_item WHERE pid = ? AND item_id = ?", args: [MANUAL_PID, itemId] });
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return false;
  await db.batch([
    { sql: "DELETE FROM costing_item WHERE pid = ? AND item_id = ?", args: [MANUAL_PID, itemId] },
    { sql: "INSERT INTO costing_change (pid, item_id, at, kind, before, after) VALUES (?, ?, ?, 'removed', ?, NULL)",
      args: [MANUAL_PID, itemId, new Date().toISOString(), JSON.stringify({ amount: row.amount, status: row.status, currency: row.currency, date: row.date, vendor: row.vendor, description: row.description })] },
  ], "write");
  return true;
}

export function rowToClean(r: Record<string, unknown>): CleanItem {
  let extra: CleanItem["extra"] = {};
  try { extra = r.extra ? JSON.parse(String(r.extra)) : {}; } catch { extra = {}; }
  return {
    id: String(r.item_id), date: String(r.date), category: String(r.category), vendor: String(r.vendor),
    service: (r.service as string) ?? null, model: (r.model as string) ?? null, description: (r.description as string) ?? null,
    billing_type: String(r.billing_type), amount: String(r.amount), units: BigInt(String(r.units)), currency: String(r.currency),
    source: String(r.source), status: r.status === "pending" ? "pending" : "final",
    invoice_id: (r.invoice_id as string) ?? null, invoice_url: (r.invoice_url as string) ?? null, extra,
  };
}
