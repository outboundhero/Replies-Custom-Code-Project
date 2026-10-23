/**
 * The Jobs page's other long-running work (lead moves have their own status: lib/leads/move-jobs.ts), each read from
 * where it's already recorded, last 30 days:
 *   resets       Hard reset / Nurture reset (hard_reset) — steps, progress, Try again / Cancel like the client page
 *   removals     nurture queue removals (nurture_queue_removals) — "Remove all", selected, service-area, reset; Undo
 *   onboarding   checklist automation runs (onboarding_task_run), grouped into one job per step run: campaign
 *                creation writes one run per campaign and domain allocation one per batch
 *   refresh      the campaign refresh (every 10 min + the Nurture page's button): the last one, and manual ones
 * Turso only — a handful of small queries.
 */
import db from "@/lib/db";
import { listResets, canCancelReset, type HardReset, type ResetStatus } from "@/lib/hard-reset/store";
import { ensureRemovalsTable } from "@/lib/nurture/queue-removals";
import { lastCampaignRefresh } from "@/lib/nurture/refresh-campaigns";
import { getInstanceLabel } from "@/lib/bison-instances-shared";

export const JOB_DAYS = 30;
const sinceIso = () => new Date(Date.now() - JOB_DAYS * 86_400_000).toISOString();
const n = (x: number) => x.toLocaleString("en-US");
const parse = <T>(v: unknown, fallback: T): T => { try { return v ? (JSON.parse(String(v)) as T) : fallback; } catch { return fallback; } };

// ── resets ──────────────────────────────────────────────────────────────────

export type StepState = "done" | "now" | "todo" | "failed" | "skipped";
export interface ResetJob {
  id: number; tag: string; kind: "hard" | "nurture"; status: ResetStatus; failedStep: ResetStatus | null; error: string | null;
  createdBy: string | null; createdAt: string; finishedAt: string | null;
  canRetry: boolean; canCancel: boolean; progress: number;
  steps: Array<{ key: string; label: string; state: StepState; detail: string }>;
}

const ORDER: ResetStatus[] = ["creating", "attaching", "repointing", "emptying", "archiving"];

function resetJob(r: HardReset): ResetJob {
  const nurture = r.kind === "nurture";
  const made = r.built.filter((b) => b.state === "created" && b.campaignId != null).length;
  const total = nurture ? 6 : 12;
  const perInst = nurture ? 3 : 6;
  const attached = [r.client.b2b, r.client.b2c].reduce((s, inst) => s + Object.values(r.attach[inst]?.campaigns ?? {}).filter((c) => c.verified).length, 0);
  const contacts = r.emptied ? r.emptied.removals.reduce((s, x) => s + x.contacts, 0) : 0;
  const archived = r.archived.length;
  // A Hard reset from before 2026-10-24 went straight from nurture to archiving: no queue step.
  const noQueueStep = !r.emptied && !nurture && (r.status === "done" || r.status === "archiving" || r.failedStep === "archiving");
  const cur = r.status === "failed" ? r.failedStep : r.status;
  const ci = cur ? ORDER.indexOf(cur) : -1;
  const state = (key: ResetStatus): StepState => {
    if (key === "emptying" && noQueueStep) return "skipped";
    if (r.status === "done") return "done";
    if (r.status === "cancelled" || r.status === "cancelling") return "todo";
    const i = ORDER.indexOf(key);
    if (ci < 0) return "todo";
    if (i < ci) return "done";
    if (i > ci) return "todo";
    return r.status === "failed" ? "failed" : "now";
  };
  const steps: ResetJob["steps"] = [
    { key: "creating", label: nurture ? "Make the 6 new Nurture 1 campaigns" : "Make the 12 new campaigns", state: state("creating"), detail: r.status === "cancelled" ? (made ? `${made} made — deleted when it was cancelled` : "cancelled before any was made") : `${made} of ${total} made` },
    { key: "attaching", label: "Attach the inboxes", state: state("attaching"), detail: `${attached} of ${perInst * 2} campaigns have their inboxes` },
    { key: "repointing", label: "Switch nurture to the new campaigns", state: state("repointing"), detail: r.nurture?.after?.length ? "done" : "nurture map → the 6 new nurture campaigns" },
    { key: "emptying", label: "Empty the nurture queue", state: state("emptying"), detail: noQueueStep ? "not part of resets before Oct 24" : r.emptied ? `${n(contacts)} contacts removed${r.emptied.done ? "" : " so far"}` : "waiting contacts removed (undoable)" },
    { key: "archiving", label: nurture ? "Archive the old nurture campaigns" : "Archive the old campaigns", state: state("archiving"), detail: `${archived} of ${r.archive.length} done` },
  ];
  const counted = steps.filter((s) => s.state !== "skipped");
  const doneSteps = counted.filter((s) => s.state === "done").length;
  const within = cur === "creating" ? made / total : cur === "attaching" ? attached / (perInst * 2) : cur === "archiving" ? (r.archive.length ? archived / r.archive.length : 0) : 0;
  const progress = r.status === "done" ? 100 : r.status === "cancelled" ? 0 : Math.round(((doneSteps + (r.status === "failed" ? 0 : within)) / counted.length) * 100);
  return {
    id: r.id, tag: r.clientTag, kind: r.kind, status: r.status, failedStep: r.failedStep, error: r.error,
    createdBy: r.createdBy, createdAt: r.createdAt, finishedAt: r.finishedAt,
    canRetry: r.status === "failed" && !!r.failedStep, canCancel: canCancelReset(r), progress, steps,
  };
}

// ── queue removals ──────────────────────────────────────────────────────────

export interface RemovalJob {
  id: number; tag: string; mode: string; label: string; contacts: number; rows: number;
  status: "done" | "failed" | "running" | "undone"; by: string | null; at: string;
  restoredAt: string | null; restoredBy: string | null; restoredRows: number | null; undoable: boolean; error: string | null;
}

const SOURCE: Record<string, string> = { seq: "sequence-finished", soft: "soft no", ooo: "out of office", other: "other replies", legacy: "legacy" };
function removalLabel(mode: string, f: Record<string, unknown> | null): string {
  if (mode === "service-area") return "Service-area change";
  if (mode === "nurture-reset") return `Reset — ${SOURCE[String(f?.source ?? "")] ?? "whole queue"}`;
  if (mode === "selected") return "Selected contacts";
  const parts: string[] = [];
  if (f?.tld) parts.push(`domain ${f.tld}`);
  if (f?.emailSuffix) parts.push(`email ends ${f.emailSuffix}`);
  if (f?.webSuffix) parts.push(`website ends ${f.webSuffix}`);
  if (f?.source) parts.push(`source ${SOURCE[String(f.source)] ?? f.source}`);
  if (f?.search) parts.push(`“${f.search}”`);
  if (f?.overlapOnly) parts.push("overlapping");
  return parts.length ? `Remove all — ${parts.join(", ")}` : "Remove all — entire queue";
}

async function removalJobs(): Promise<RemovalJob[]> {
  await ensureRemovalsTable();
  const rows = (await db.execute({
    sql: `SELECT id, client_tag, removed_at, removed_by, mode, contacts, row_count, filters_json, restored_at, restored_by, restored_rows, status, error,
            ids_json IS NOT NULL AS has_ids
          FROM nurture_queue_removals WHERE removed_at > ? ORDER BY id DESC LIMIT 100`,
    args: [sinceIso()],
  })).rows;
  return rows.map((x) => {
    const mode = String(x.mode ?? "selected");
    const st = String(x.status ?? "done");
    const status: RemovalJob["status"] = x.restored_at ? "undone" : st === "failed" ? "failed" : st === "pending" ? "running" : "done";
    return {
      id: Number(x.id), tag: String(x.client_tag), mode, label: removalLabel(mode, parse<Record<string, unknown> | null>(x.filters_json, null)),
      contacts: Number(x.contacts) || 0, rows: Number(x.row_count) || 0, status, by: (x.removed_by as string) ?? null, at: String(x.removed_at),
      restoredAt: (x.restored_at as string) ?? null, restoredBy: (x.restored_by as string) ?? null, restoredRows: x.restored_rows == null ? null : Number(x.restored_rows),
      undoable: status === "done" && Number(x.has_ids) === 1 && mode !== "service-area" && (Number(x.row_count) || 0) > 0,
      error: (x.error as string) ?? null,
    };
  });
}

// ── onboarding runs ─────────────────────────────────────────────────────────

export interface OnboardingJob {
  key: string; tag: string; automation: string; label: string;
  runs: number; ok: number; failed: number; running: boolean;
  startedAt: string; finishedAt: string | null; by: string | null; summary: string; lastError: string | null;
  status: "running" | "done" | "failed" | "partly";
}

export const STEP_LABEL: Record<string, string> = {
  slack_outreachify: "Slack message to Outreachify",
  replyrouter_setup: "Reply Router set-up",
  create_campaigns: "Campaign creation",
  allocate_domains: "Domain allocation",
  whitelist_email: "Whitelisting email",
  go_live_email: "Go-live email",
};
/** A step's runs more than this apart are separate jobs (a step run again later). */
const SESSION_GAP_MS = 30 * 60_000;
/** An unfinished run older than this was abandoned (the store closes them the same way). */
const RUN_STALE_MS = 6 * 60_000;

function runSummary(automation: string, results: unknown[], ok: number): string {
  if (automation === "create_campaigns") {
    let made = 0, failed = 0;
    for (const r of results) for (const c of (r as { results?: Array<{ state?: string }> })?.results ?? []) { if (c.state === "created") made++; else if (c.state === "failed") failed++; }
    return `${made} campaign${made === 1 ? "" : "s"} made${failed ? ` · ${failed} failed` : ""}`;
  }
  if (automation === "allocate_domains") {
    const byInst: Record<string, number> = {};
    for (const r of results) { const x = r as { instance?: string; domains?: string[] }; if (x?.instance) byInst[x.instance] = (byInst[x.instance] || 0) + (x.domains?.length ?? 0); }
    const total = Object.values(byInst).reduce((a, b) => a + b, 0);
    return `${total} domain${total === 1 ? "" : "s"} allocated${Object.keys(byInst).length ? ` (${Object.entries(byInst).map(([i, c]) => `${getInstanceLabel(i)} ${c}`).join(", ")})` : ""}`;
  }
  if (automation === "whitelist_email") {
    const d = (results.at(-1) as { domains?: string[] } | undefined)?.domains?.length ?? 0;
    return ok ? `email sent${d ? ` (${d} domains)` : ""}` : "not sent";
  }
  if (automation === "slack_outreachify") {
    const sent = (results.at(-1) as { sent?: string[] } | undefined)?.sent ?? [];
    return ok ? `sent${sent.length ? ` to ${sent.join(", ")}` : ""}` : "not sent";
  }
  if (automation === "go_live_email") return ok ? "email sent" : "not sent";
  return ok ? "done" : "not done";
}

async function onboardingJobs(): Promise<OnboardingJob[]> {
  let rows: Record<string, unknown>[] = [];
  try {
    rows = (await db.execute({
      sql: `SELECT id, task_id, client_tag, automation, started_at, finished_at, ok, run_by, result, error
            FROM onboarding_task_run WHERE started_at > ? ORDER BY task_id, started_at LIMIT 2000`,
      args: [sinceIso()],
    })).rows as Record<string, unknown>[];
  } catch { return []; } // table not created yet
  const jobs: OnboardingJob[] = [];
  let cur: { rows: Record<string, unknown>[]; last: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const rs = cur.rows;
    const first = rs[0];
    const automation = String(first.automation);
    const running = rs.some((r) => !r.finished_at && Date.now() - Date.parse(String(r.started_at)) < RUN_STALE_MS);
    const ok = rs.filter((r) => Number(r.ok) === 1).length;
    const failed = rs.filter((r) => r.finished_at && Number(r.ok) !== 1).length;
    const lastRun = rs[rs.length - 1];
    const lastFailed = [...rs].reverse().find((r) => r.finished_at && Number(r.ok) !== 1);
    const status: OnboardingJob["status"] = running ? "running" : Number(lastRun.ok) === 1 ? (failed ? "partly" : "done") : "failed";
    jobs.push({
      key: `${first.task_id}:${first.id}`, tag: String(first.client_tag), automation, label: STEP_LABEL[automation] ?? automation,
      runs: rs.length, ok, failed, running, startedAt: String(first.started_at),
      finishedAt: running ? null : ((lastRun.finished_at as string) ?? null), by: (first.run_by as string) ?? null,
      summary: runSummary(automation, rs.filter((r) => Number(r.ok) === 1).map((r) => parse<unknown>(r.result, null)), ok),
      lastError: (lastFailed?.error as string) ?? null, status,
    });
    cur = null;
  };
  for (const r of rows) {
    const t = Date.parse(String(r.started_at));
    const sameTask = cur && cur.rows[0].task_id === r.task_id && t - cur.last < SESSION_GAP_MS;
    if (!sameTask) { flush(); cur = { rows: [], last: t }; }
    cur!.rows.push(r);
    cur!.last = Date.parse(String(r.finished_at ?? r.started_at));
  }
  flush();
  return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 80);
}

// ── campaign refresh ────────────────────────────────────────────────────────

export interface RefreshJob {
  running: boolean;
  last: { at: string; ms: number; cached: number; mains: number; by: string | null; manual: boolean; failures: string[]; revived: number | null } | null;
  manual: Array<{ at: string; by: string | null; ms: number | null; cached: number | null; failures: string[] }>;
}

async function refreshJob(): Promise<RefreshJob> {
  const { last, running } = await lastCampaignRefresh();
  const manual = (await db.execute({
    sql: "SELECT timestamp, details FROM activity_log WHERE workflow = 'nurture' AND action = 'campaigns-refreshed' AND timestamp > ? ORDER BY id DESC LIMIT 20",
    args: [sinceIso().replace("T", " ").slice(0, 19)],
  }).catch(() => ({ rows: [] as Record<string, unknown>[] }))).rows.map((x) => {
    const d = parse<{ by?: string; ms?: number; cached?: number; failures?: unknown[] }>(x.details, {});
    return { at: String(x.timestamp).replace(" ", "T") + "Z", by: d.by ?? null, ms: d.ms ?? null, cached: d.cached ?? null, failures: (d.failures ?? []).map(String) };
  });
  const l = last as (typeof last & { failures?: unknown[]; revivedCompleted?: { revived?: number } }) | null;
  return {
    running,
    last: l ? { at: l.at, ms: l.ms, cached: l.cached, mains: l.mains, by: l.by ?? null, manual: !!l.manual, failures: (l.failures ?? []).map(String), revived: l.revivedCompleted?.revived ?? null } : null,
    manual,
  };
}

export interface JobsOverview { resets: ResetJob[]; removals: RemovalJob[]; onboarding: OnboardingJob[]; refresh: RefreshJob }

export async function jobsOverview(): Promise<JobsOverview> {
  const [resets, removals, onboarding, refresh] = await Promise.all([
    listResets(sinceIso()).then((rs) => rs.map(resetJob)),
    removalJobs(),
    onboardingJobs(),
    refreshJob(),
  ]);
  return { resets, removals, onboarding, refresh };
}
