/**
 * What nurture produces: leads delivered to clients (pushed to their lead
 * sheets), credited to the campaign stage they came from — Main, Nurture 1,
 * Nurture 2, … — and to the inbox type of that campaign (Google / Outlook / SEGs).
 *
 * A lead counts ONCE per client: a prospect who replies several times has
 * several replies marked pushed, so leads are keyed by client + email and
 * credited to the campaign of their FIRST delivery.
 *
 * Source: Supabase `replies` (pushed_to_sheet = true), read through the
 * (lead_category, created_at) index one category at a time — never a full
 * table scan — by a background job (every 6 hours) that holds the system-wide
 * heavy-query lease and stands down when the shared database is busy. The
 * result is one small Turso table the pages read.
 */
import db from "@/lib/db";
import supabase from "@/lib/supabase";
import { detectCampaignEsp } from "@/lib/nurture/esp";
import { acquireHeavyLease, renewHeavyLease, releaseHeavyLease, leaseHolder } from "@/lib/nurture/heavy-lease";

/** Categories a delivered lead can have (pushed as one of the first four; some are re-categorised after). */
export const DELIVERY_CATEGORIES = ["Meeting-Ready Lead", "Meeting Ready Lead", "Interested", "Follow Up", "Referral Given", "Meeting Request", "Meeting Set"];

/** Stage of a campaign by its name: 0 = main, n = Nurture batch n ("[Nurture]" = 1, "[Nurture 3]" = 3, legacy "— Batch 2" = 2). */
export function stageOf(name: string | null | undefined): number | null {
  if (!name) return null;
  if (!/\bnurture\b/i.test(name)) return 0;
  const marker = name.match(/\[nurture\s*(\d+)\]/i);
  if (marker) return Math.max(1, Number(marker[1]));
  const suffix = name.match(/[—-]\s*batch\s*(\d+)\s*$/i);
  return suffix ? Math.max(1, Number(suffix[1])) : 1;
}

/** The result groups shown for a delivered lead's category. */
export function categoryGroup(category: string | null | undefined): "meeting" | "interested" | "followup" | "referral" | "other" {
  const c = String(category || "").toLowerCase();
  if (/meeting/.test(c)) return "meeting";
  if (/interested/.test(c)) return "interested";
  if (/follow/.test(c)) return "followup";
  if (/referral/.test(c)) return "referral";
  return "other";
}

let tableReady: Promise<void> | null = null;
export function ensureResultsTable(): Promise<void> {
  if (!tableReady) {
    tableReady = db.batch([
      `CREATE TABLE IF NOT EXISTS nurture_delivered_leads (
        client_tag TEXT NOT NULL, email TEXT NOT NULL, stage INTEGER, esp TEXT, category TEXT,
        delivered_at TEXT NOT NULL, campaign_id INTEGER, instance TEXT, campaign_name TEXT, reply_id INTEGER,
        PRIMARY KEY (client_tag, email)
      )`,
      "CREATE TABLE IF NOT EXISTS cron_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)",
    ], "write").then(() => undefined).catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

/** Is the shared database slow right now? (Same probe the queue-stats job uses.) */
async function databaseBusy(thresholdMs = 700): Promise<boolean> {
  const one = async () => {
    const t = Date.now();
    const { error } = await supabase.from("replies").select("id").order("id", { ascending: false }).limit(1);
    return error ? Infinity : Date.now() - t;
  };
  if ((await one()) < thresholdMs) return false;
  return (await one()) >= thresholdMs;
}

interface ReplyRow {
  id: number; client_tag: string | null; lead_email: string | null; campaign_id: number | null; campaign_name: string | null;
  bison_instance: string | null; lead_category: string | null; pushed_to_sheet_at: string | null; created_at: string;
}
interface Lead {
  tag: string; email: string; stage: number | null; esp: string | null; category: string | null;
  at: string; campaignId: number | null; instance: string | null; campaignName: string | null; replyId: number;
}

const PAGE = 1000;
const LEASE_MS = 3 * 60_000;

/**
 * Rebuild the delivered-leads table from Supabase. Returns what it did, or why
 * it stood down (busy database / another heavy job running). Never throws for
 * those — the next run tries again.
 */
export async function refreshDeliveredLeads(): Promise<{ ok: boolean; skipped?: string; leads?: number; replies?: number; unmatched?: number; ms?: number }> {
  const t0 = Date.now();
  await ensureResultsTable();
  if (await databaseBusy()) return { ok: false, skipped: "the shared database is busy — trying again next run" };
  const holder = leaseHolder("nurture-results");
  if (!(await acquireHeavyLease(holder, LEASE_MS))) return { ok: false, skipped: "another heavy job is running — trying again next run" };
  try {
    // 1) Every delivered reply, one category at a time through the category index.
    const rows: ReplyRow[] = [];
    const seen = new Set<number>();
    for (const category of DELIVERY_CATEGORIES) {
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase
          .from("replies")
          .select("id, client_tag, lead_email, campaign_id, campaign_name, bison_instance, lead_category, pushed_to_sheet_at, created_at")
          .eq("lead_category", category)
          .eq("pushed_to_sheet", true)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (error) throw new Error(`reading delivered replies (${category}): ${error.message}`);
        for (const r of (data ?? []) as ReplyRow[]) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
        if (!data || data.length < PAGE) break;
        // Hold the lease between pages; if it was lost, stop rather than run beside another heavy job.
        if (!(await renewHeavyLease(holder, LEASE_MS))) throw new Error("lost the heavy-query lease part-way — trying again next run");
      }
    }

    // 2) Names for replies that only kept the campaign id (looked up in the campaign caches).
    const names = new Map<string, string>();
    const caches = await Promise.all([
      db.execute("SELECT id, bison_instance, name FROM nurture_campaigns_cache").catch(() => ({ rows: [] as unknown[] })),
      db.execute("SELECT id, bison_instance, name FROM main_campaigns_cache").catch(() => ({ rows: [] as unknown[] })),
    ]);
    for (const c of caches) for (const r of c.rows as Array<Record<string, unknown>>) names.set(`${r.bison_instance}:${r.id}`, String(r.name ?? ""));

    // 3) One lead per client + email, credited to its first delivery.
    const leads = new Map<string, Lead>();
    for (const r of rows) {
      const tag = String(r.client_tag ?? "").trim().toUpperCase();
      const email = String(r.lead_email ?? "").trim().toLowerCase();
      if (!tag || tag === "N/A" || !email) continue;
      const at = r.pushed_to_sheet_at || r.created_at;
      const key = `${tag}|${email}`;
      const had = leads.get(key);
      if (had && had.at <= at) continue;
      const name = r.campaign_name || (r.campaign_id != null && r.bison_instance ? names.get(`${r.bison_instance}:${r.campaign_id}`) ?? null : null);
      const esp = detectCampaignEsp(name);
      leads.set(key, {
        tag, email, stage: stageOf(name), esp: esp ?? (name ? "other" : null), category: r.lead_category,
        at, campaignId: r.campaign_id, instance: r.bison_instance, campaignName: name, replyId: r.id,
      });
    }

    // 4) Replace the table in one transaction (readers never see it half-filled).
    const all = [...leads.values()];
    const stmts: Array<{ sql: string; args: Array<string | number | null> }> = [{ sql: "DELETE FROM nurture_delivered_leads", args: [] }];
    for (let i = 0; i < all.length; i += 200) {
      const chunk = all.slice(i, i + 200);
      stmts.push({
        sql: `INSERT INTO nurture_delivered_leads (client_tag, email, stage, esp, category, delivered_at, campaign_id, instance, campaign_name, reply_id) VALUES ${chunk.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",")}`,
        args: chunk.flatMap((l) => [l.tag, l.email, l.stage, l.esp, l.category, l.at, l.campaignId, l.instance, l.campaignName, l.replyId]),
      });
    }
    await db.batch(stmts, "write");
    const unmatched = all.filter((l) => l.stage == null).length;
    const result = { ok: true, leads: all.length, replies: rows.length, unmatched, ms: Date.now() - t0 };
    await db.execute({
      sql: "INSERT INTO cron_state (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      args: ["nurture:results", JSON.stringify({ at: new Date().toISOString(), ...result })],
    });
    return result;
  } finally {
    await releaseHeavyLease(holder).catch(() => undefined);
  }
}

// ── reading (Turso only — cheap) ─────────────────────────────────────────────

/** Delivered leads per client since a date: { main, nurture, unknown } (for the overview table). */
export async function deliveredByTag(sinceIso: string): Promise<Map<string, { main: number; nurture: number; unknown: number }>> {
  const out = new Map<string, { main: number; nurture: number; unknown: number }>();
  try {
    await ensureResultsTable();
    const r = await db.execute({
      sql: "SELECT client_tag, stage, COUNT(*) AS n FROM nurture_delivered_leads WHERE delivered_at >= ? GROUP BY client_tag, stage",
      args: [sinceIso],
    });
    for (const x of r.rows) {
      const T = String(x.client_tag).toUpperCase();
      const m = out.get(T) ?? { main: 0, nurture: 0, unknown: 0 };
      const n = Number(x.n) || 0;
      if (x.stage == null) m.unknown += n; else if (Number(x.stage) === 0) m.main += n; else m.nurture += n;
      out.set(T, m);
    }
  } catch { /* table not built yet — no numbers */ }
  return out;
}

export interface StageResult {
  stage: number | null;  // 0 main, n = Nurture n, null = couldn't be matched to a campaign
  leads: number;
  categories: Record<"meeting" | "interested" | "followup" | "referral" | "other", number>;
  esps: Record<"google" | "outlook" | "segs" | "other", number>;
}
export interface ResultsView {
  days: number | null;
  total: number;
  fromNurture: number;
  stages: StageResult[];
  /** The chart: by week (Monday) for a 30 / 90 day window, by month for all time. */
  trend: { by: "week" | "month"; points: Array<{ key: string; main: number; nurture: number; unknown: number }> };
  tags: Array<{ tag: string; total: number; main: number; nurture: number }>;
  trackedSince: string | null;
  refreshedAt: string | null;
  lastRun: Record<string, unknown> | null;
}

type TrendPoint = { key: string; main: number; nurture: number; unknown: number };
const DAY_MS = 86_400_000;
/** The Monday (UTC) of the week a moment falls in, as YYYY-MM-DD — matches SQLite's date(x, '-6 days', 'weekday 1'). */
const mondayOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7))).toISOString().slice(0, 10);
const nextMonth = (m: string) => { const [y, mo] = m.split("-").map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; };
/** Every period from `from` through the current one, with empty ones as zeros, so a quiet stretch shows as a gap. */
function fillPeriods(map: Map<string, TrendPoint>, from: string, end: string, next: (k: string) => string): TrendPoint[] {
  const out: TrendPoint[] = [];
  for (let k = from, i = 0; k <= end && i < 120; k = next(k), i++) out.push(map.get(k) ?? { key: k, main: 0, nurture: 0, unknown: 0 });
  return out;
}

/** Delivered leads for one client (or all of them), over the last N days (null = all time). */
export async function resultsView(opts: { tag?: string | null; days: number | null }): Promise<ResultsView> {
  await ensureResultsTable();
  const tag = opts.tag ? opts.tag.trim().toUpperCase() : null;
  const since = opts.days ? new Date(Date.now() - opts.days * 86_400_000).toISOString() : "";
  const where: string[] = [], args: string[] = [];
  if (tag) { where.push("client_tag = ?"); args.push(tag); }
  if (since) { where.push("delivered_at >= ?"); args.push(since); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, months, tags, first, state, weeks] = await Promise.all([
    db.execute({ sql: `SELECT stage, esp, category, COUNT(*) AS n FROM nurture_delivered_leads ${w} GROUP BY stage, esp, category`, args }),
    db.execute({ sql: `SELECT substr(delivered_at, 1, 7) AS m, stage, COUNT(*) AS n FROM nurture_delivered_leads ${tag ? "WHERE client_tag = ?" : ""} GROUP BY m, stage ORDER BY m`, args: tag ? [tag] : [] }),
    tag ? Promise.resolve({ rows: [] as unknown[] })
      : db.execute({ sql: `SELECT client_tag, SUM(CASE WHEN stage = 0 THEN 1 ELSE 0 END) AS main, SUM(CASE WHEN stage > 0 THEN 1 ELSE 0 END) AS nurture, COUNT(*) AS total FROM nurture_delivered_leads ${w} GROUP BY client_tag ORDER BY nurture DESC, total DESC`, args }),
    // When delivery tracking really began: the first month with a real volume of deliveries
    // (sheet pushes started in August 2026; a handful of earlier ones would mislead).
    db.execute("SELECT substr(delivered_at, 1, 7) AS m, COUNT(*) AS n FROM nurture_delivered_leads GROUP BY m ORDER BY m"),
    db.execute({ sql: "SELECT value, updated_at FROM cron_state WHERE key = ?", args: ["nurture:results"] }),
    // Week starting Monday, for the window's chart.
    opts.days ? db.execute({ sql: `SELECT date(delivered_at, '-6 days', 'weekday 1') AS w, stage, COUNT(*) AS n FROM nurture_delivered_leads ${w} GROUP BY w, stage ORDER BY w`, args }) : Promise.resolve({ rows: [] as unknown[] }),
  ]);

  const byStage = new Map<string, StageResult>();
  for (const r of rows.rows as Array<Record<string, unknown>>) {
    const stage = r.stage == null ? null : Number(r.stage);
    const k = String(stage);
    const s = byStage.get(k) ?? { stage, leads: 0, categories: { meeting: 0, interested: 0, followup: 0, referral: 0, other: 0 }, esps: { google: 0, outlook: 0, segs: 0, other: 0 } };
    const n = Number(r.n) || 0;
    s.leads += n;
    s.categories[categoryGroup(r.category as string | null)] += n;
    const esp = String(r.esp ?? "other") as keyof StageResult["esps"];
    s.esps[esp in s.esps ? esp : "other"] += n;
    byStage.set(k, s);
  }
  const stages = [...byStage.values()].sort((a, b) => (a.stage ?? 99) - (b.stage ?? 99));
  const total = stages.reduce((n, s) => n + s.leads, 0);
  const fromNurture = stages.filter((s) => (s.stage ?? 0) > 0).reduce((n, s) => n + s.leads, 0);

  const monthMap = new Map<string, { month: string; main: number; nurture: number; unknown: number }>();
  for (const r of months.rows as Array<Record<string, unknown>>) {
    const m = String(r.m);
    const e = monthMap.get(m) ?? { month: m, main: 0, nurture: 0, unknown: 0 };
    const n = Number(r.n) || 0;
    if (r.stage == null) e.unknown += n; else if (Number(r.stage) === 0) e.main += n; else e.nurture += n;
    monthMap.set(m, e);
  }

  const weekMap = new Map<string, TrendPoint>();
  for (const r of weeks.rows as Array<Record<string, unknown>>) {
    if (!r.w) continue;
    const k = String(r.w);
    const e = weekMap.get(k) ?? { key: k, main: 0, nurture: 0, unknown: 0 };
    const n = Number(r.n) || 0;
    if (r.stage == null) e.unknown += n; else if (Number(r.stage) === 0) e.main += n; else e.nurture += n;
    weekMap.set(k, e);
  }

  let lastRun: Record<string, unknown> | null = null;
  const st = state.rows[0] as Record<string, unknown> | undefined;
  try { lastRun = st ? JSON.parse(String(st.value)) : null; } catch { lastRun = null; }
  const perMonth = (first.rows as Array<Record<string, unknown>>).map((r) => ({ m: String(r.m), n: Number(r.n) || 0 }));
  const peak = Math.max(0, ...perMonth.map((x) => x.n));
  const startMonth = perMonth.find((x) => x.n >= Math.max(1, peak * 0.1))?.m ?? null;

  // The chart runs to the current week / month. It starts at the window's start, but not before
  // tracking began, unless there's an earlier delivery in the window.
  const now = new Date();
  let trend: ResultsView["trend"];
  if (opts.days) {
    const firstData = [...weekMap.keys()].sort()[0];
    const startWeek = [mondayOf(new Date(since)), startMonth ? mondayOf(new Date(`${startMonth}-01T00:00:00Z`)) : ""].sort().pop()!;
    const from = firstData && firstData < startWeek ? firstData : startWeek;
    trend = { by: "week", points: weekMap.size ? fillPeriods(weekMap, from, mondayOf(now), (k) => new Date(Date.parse(`${k}T00:00:00Z`) + 7 * DAY_MS).toISOString().slice(0, 10)) : [] };
  } else {
    const byMonth = new Map([...monthMap.values()].map((m) => [m.month, { key: m.month, main: m.main, nurture: m.nurture, unknown: m.unknown }]));
    trend = { by: "month", points: startMonth && monthMap.size ? fillPeriods(byMonth, startMonth, now.toISOString().slice(0, 7), nextMonth) : [] };
  }

  return {
    days: opts.days, total, fromNurture, stages,
    trend,
    tags: (tags.rows as Array<Record<string, unknown>>).map((r) => ({ tag: String(r.client_tag), total: Number(r.total) || 0, main: Number(r.main) || 0, nurture: Number(r.nurture) || 0 })),
    trackedSince: startMonth ? `${startMonth}-01` : null,
    refreshedAt: lastRun && typeof lastRun.at === "string" ? lastRun.at : null,
    lastRun,
  };
}
