/**
 * LeadRush CRM integration (client request 2026-10-06).
 *
 * When a reply for OH / DM4PM / UJ lands in a hot category (Interested, Meeting
 * Request, Meeting-Ready Lead, Meeting Set, Follow Up, Referral Given), POST the
 * lead to LeadRush's notify endpoint. Fires on the category the team confirms
 * in the inbox / Data View, plus the automatic "Meeting-Ready Lead" at ingest
 * (the client's own team is on the thread). Runs ALONGSIDE the existing Clay
 * pushes for OH / DM4PM (lib/oh-webhook.ts, lib/dm4pm-webhook.ts) — those stay.
 *
 * Delivery is durable: one notification per lead per category (idempotency key
 * `rr_lead_<id>:<category>`), recorded in Turso `leadrush_notifications`. A
 * failure (or a missing secret) leaves it pending, and the leadrush-retry cron
 * re-sends with backoff; it only lands in the Error Log once retries run out.
 *
 * Env: LEADRUSH_NOTIFY_SECRET (their shared secret, sent as a Bearer token).
 * LEADRUSH_NOTIFY_URL overrides the endpoint (tests only).
 *
 * Also keeps a per-lead category history (Turso `lead_category_history`) for
 * these clients — served by the LeadRush lookup API (app/api/leadrush/leads).
 */
import db from "@/lib/db";
import supabase from "@/lib/supabase";
import { logError } from "@/lib/errors";
import { stripQuotedHistory } from "@/lib/qualification/strip-quoted";
import { isOhCloseExcluded } from "@/lib/close-crm";

export const LEADRUSH_TAGS = ["OH", "DM4PM", "UJ"] as const;
export const LEADRUSH_CATEGORIES = [
  "Interested",
  "Meeting Request",
  "Meeting-Ready Lead",
  "Meeting Ready Lead",
  "Meeting Set",
  "Follow Up",
  "Referral Given",
];
const DEFAULT_URL = "https://leadrush-close-seven.vercel.app/api/webhooks/notify";
const APP_URL = "https://replies-custom-code-project.vercel.app";
const MAX_ATTEMPTS = 8;
// Minutes to wait after the Nth failed attempt.
const BACKOFF_MIN = [5, 15, 30, 60, 120, 240, 480];

export function isLeadRushTag(tag: string | null | undefined): boolean {
  return (LEADRUSH_TAGS as readonly string[]).includes(String(tag || "").trim().toUpperCase());
}
export function isLeadRushCategory(category: string | null | undefined): boolean {
  const c = String(category || "").trim().toLowerCase();
  return !!c && LEADRUSH_CATEGORIES.some((x) => x.toLowerCase() === c);
}

/** `rr_lead_12345:meeting-ready-lead` — stable per lead + category. */
export function leadRushKey(replyRowId: number, category: string): string {
  return `rr_lead_${replyRowId}:${category.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

// ── Tables ────────────────────────────────────────────────────────────────────
let ready: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ready) {
    ready = db.batch([
      `CREATE TABLE IF NOT EXISTS leadrush_notifications (
        idempotency_key TEXT PRIMARY KEY,
        reply_row_id INTEGER NOT NULL,
        client_tag TEXT,
        category TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        sent_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_leadrush_notif_due ON leadrush_notifications (status, next_attempt_at)`,
      `CREATE TABLE IF NOT EXISTS lead_category_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reply_row_id INTEGER NOT NULL,
        client_tag TEXT,
        category TEXT NOT NULL,
        changed_by TEXT,
        source TEXT,
        changed_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_lead_cat_hist_row ON lead_category_history (reply_row_id)`,
    ], "write").then(() => undefined).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── Category history ────────────────────────────────────────────────────────
/** Record a category change for a LeadRush client's lead (no-op for others). */
export async function recordCategoryChange(
  replyRowId: number, clientTag: string | null | undefined, category: string,
  changedBy: string | null, source: "inbox" | "ingest",
): Promise<void> {
  if (!isLeadRushTag(clientTag) || !category) return;
  try {
    await ensureTables();
    await db.execute({
      sql: "INSERT INTO lead_category_history (reply_row_id, client_tag, category, changed_by, source) VALUES (?, ?, ?, ?, ?)",
      args: [replyRowId, String(clientTag).toUpperCase(), category, changedBy, source],
    });
  } catch (e) {
    console.warn("[leadrush] category history write failed:", (e as Error).message);
  }
}

export async function getCategoryHistory(replyRowIds: number[]): Promise<Map<number, { category: string; changed_at: string; changed_by: string | null; source: string | null }[]>> {
  const out = new Map<number, { category: string; changed_at: string; changed_by: string | null; source: string | null }[]>();
  if (!replyRowIds.length) return out;
  await ensureTables();
  const r = await db.execute({
    sql: `SELECT reply_row_id, category, changed_at, changed_by, source FROM lead_category_history
          WHERE reply_row_id IN (${replyRowIds.map(() => "?").join(",")}) ORDER BY id`,
    args: replyRowIds,
  });
  for (const row of r.rows) {
    const id = Number(row.reply_row_id);
    if (!out.has(id)) out.set(id, []);
    out.get(id)!.push({
      category: String(row.category),
      changed_at: `${String(row.changed_at).replace(" ", "T")}Z`,
      changed_by: (row.changed_by as string | null) ?? null,
      source: (row.source as string | null) ?? null,
    });
  }
  return out;
}

// ── Lead shape (shared by the notify payload and the lookup API) ────────────
export const LEAD_COLUMNS =
  "id, client_tag, lead_category, ai_categorized_lead_category, lead_name, first_name, last_name, lead_email, phone, company_name, reply_we_got, reply_time, created_at, updated_at, categorized_at, campaign_name, city, state, address, archived";

export interface LeadRushLead {
  reply_router_lead_id: string;
  client: string;
  category: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  reply_snippet: string;
  reply_time: string | null;
  campaign: string;
  city: string;
  state: string;
  address: string;
  reply_router_url: string;
}

const realPhone = (p: unknown) => (String(p ?? "").replace(/\D/g, "").length >= 7 ? String(p).trim() : "");

export function toLeadRushLead(r: Record<string, unknown>, category?: string): LeadRushLead {
  const id = Number(r.id);
  const name = String(r.lead_name || `${r.first_name || ""} ${r.last_name || ""}`).trim();
  const snippet = stripQuotedHistory(String(r.reply_we_got || "")).replace(/\s+/g, " ").trim();
  return {
    reply_router_lead_id: String(id),
    client: String(r.client_tag || "").toUpperCase(),
    category: category || String(r.lead_category || "Open Response"),
    name,
    email: String(r.lead_email || ""),
    phone: realPhone(r.phone),
    company: String(r.company_name || ""),
    reply_snippet: snippet.length > 500 ? `${snippet.slice(0, 497)}…` : snippet,
    reply_time: r.reply_time ? new Date(String(r.reply_time)).toISOString() : null,
    campaign: String(r.campaign_name || ""),
    city: String(r.city || ""),
    state: String(r.state || ""),
    address: String(r.address || ""),
    reply_router_url: `${APP_URL}/inbox?reply=${id}`,
  };
}

/** "[OH] Interested: Jane Doe (Acme Cleaning) jane@acme.com | +15551234567 | RR 12345" */
function notifyText(l: LeadRushLead): string {
  const who = [l.name || l.email, l.company ? `(${l.company})` : "", l.name ? l.email : ""].filter(Boolean).join(" ");
  return [`[${l.client}] ${l.category}: ${who}`, l.phone, `RR ${l.reply_router_lead_id}`].filter(Boolean).join(" | ");
}

// ── Notify ──────────────────────────────────────────────────────────────────
/**
 * Queue + send the LeadRush notification for a lead entering a hot category.
 * Safe to call from any category change: non-LeadRush clients / categories are
 * ignored, and a (lead, category) already delivered is never re-sent.
 */
export async function notifyLeadRush(
  replyRowId: number, clientTag: string | null | undefined, category: string | null | undefined,
): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  if (!isLeadRushTag(clientTag)) return { ok: true, skipped: "not a LeadRush client" };
  if (!isLeadRushCategory(category)) return { ok: true, skipped: "not a hot category" };
  const tag = String(clientTag).toUpperCase();
  const cat = String(category).trim();
  const key = leadRushKey(replyRowId, cat);
  try {
    await ensureTables();
    const existing = await db.execute({ sql: "SELECT status FROM leadrush_notifications WHERE idempotency_key = ?", args: [key] });
    const status = existing.rows[0]?.status as string | undefined;
    if (status === "sent") return { ok: true, skipped: "already sent" };
    if (status === "skipped") return { ok: true, skipped: "excluded" };
    if (!status) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO leadrush_notifications (idempotency_key, reply_row_id, client_tag, category, status, next_attempt_at)
              VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
        args: [key, replyRowId, tag, cat],
      });
    }
    return await deliver(key);
  } catch (e) {
    // Queued (or not) — the retry cron picks pending rows up; never block the caller.
    console.error("[leadrush] notify failed:", (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

/** Send one queued notification and record the outcome. */
async function deliver(key: string): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const row = (await db.execute({ sql: "SELECT * FROM leadrush_notifications WHERE idempotency_key = ?", args: [key] })).rows[0];
  if (!row) return { ok: false, error: "not queued" };
  if (row.status === "sent") return { ok: true, skipped: "already sent" };
  const attempts = Number(row.attempts || 0);

  const secret = process.env.LEADRUSH_NOTIFY_SECRET?.trim();
  if (!secret) {
    // Not configured yet: keep it pending (no attempt counted) so it goes out
    // as soon as the secret is added — nothing is lost in the meantime.
    await db.execute({
      sql: "UPDATE leadrush_notifications SET last_error = ?, next_attempt_at = datetime('now', '+10 minutes') WHERE idempotency_key = ?",
      args: ["LEADRUSH_NOTIFY_SECRET is not set", key],
    });
    return { ok: false, skipped: "not configured" };
  }

  const { data: r, error } = await supabase.from("replies").select(LEAD_COLUMNS).eq("id", Number(row.reply_row_id)).single();
  if (error || !r) return fail(key, attempts, `reply ${row.reply_row_id} not found: ${error?.message || ""}`);

  const lead = toLeadRushLead(r as Record<string, unknown>, String(row.category));
  // OH's own customers / existing contacts are never pushed into its CRM
  // (same list the old Close.com push used).
  if (lead.client === "OH" && isOhCloseExcluded(lead.email)) {
    await db.execute({ sql: "UPDATE leadrush_notifications SET status = 'skipped', last_error = 'existing OH customer domain' WHERE idempotency_key = ?", args: [key] });
    return { ok: true, skipped: "excluded" };
  }

  const payload = { text: notifyText(lead), idempotency_key: key, ...lead };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(process.env.LEADRUSH_NOTIFY_URL || DEFAULT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!res.ok) return fail(key, attempts, `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await db.execute({
      sql: "UPDATE leadrush_notifications SET status = 'sent', attempts = ?, sent_at = datetime('now'), last_error = NULL, next_attempt_at = NULL WHERE idempotency_key = ?",
      args: [attempts + 1, key],
    });
    return { ok: true };
  } catch (e) {
    return fail(key, attempts, (e as Error).name === "AbortError" ? "timed out after 15s" : (e as Error).message);
  }
}

async function fail(key: string, prevAttempts: number, message: string): Promise<{ ok: false; error: string }> {
  const attempts = prevAttempts + 1;
  const exhausted = attempts >= MAX_ATTEMPTS;
  const wait = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
  await db.execute({
    sql: `UPDATE leadrush_notifications SET status = ?, attempts = ?, last_error = ?,
            next_attempt_at = ${exhausted ? "NULL" : `datetime('now', '+${wait} minutes')`}
          WHERE idempotency_key = ?`,
    args: [exhausted ? "failed" : "pending", attempts, message.slice(0, 500), key],
  });
  if (exhausted) {
    await logError("leadrush", "notify", `LeadRush notify gave up after ${attempts} attempts: ${message}`, { idempotency_key: key });
  }
  return { ok: false, error: message };
}

/** Cron: re-send every due pending notification (oldest first). */
export async function retryLeadRushNotifications(limit = 25): Promise<{ due: number; sent: number; failed: number; notConfigured: number }> {
  await ensureTables();
  const due = await db.execute({
    sql: "SELECT idempotency_key FROM leadrush_notifications WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now')) ORDER BY created_at LIMIT ?",
    args: [limit],
  });
  let sent = 0, failed = 0, notConfigured = 0;
  for (const row of due.rows) {
    const r = await deliver(String(row.idempotency_key));
    if (r.ok && !r.skipped) sent++;
    else if (r.skipped === "not configured") notConfigured++;
    else if (!r.ok) failed++;
  }
  return { due: due.rows.length, sent, failed, notConfigured };
}
