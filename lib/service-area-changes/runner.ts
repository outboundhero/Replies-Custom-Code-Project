/**
 * Service-area removals — the background runner. Leases one change (one at a
 * time across all clients, so scans and removals never pile onto Email Bison),
 * works it in small saved windows until the ~285s budget, then re-triggers
 * itself so the work keeps moving. The every-2-minutes cron is the backstop that
 * resumes anything stalled and starts removals when their day comes. A long
 * scan steps aside when another client's removal is due.
 */
import { logActivity, logError } from "@/lib/errors";
import { clientCampaigns, runTaskWindow, scanTasks } from "@/lib/service-area-changes/scan";
import { runRecheck, runRemoval, runVerify } from "@/lib/service-area-changes/remove";
import {
  addTasks, getChange, heartbeat, leaseChange, patchChange, pendingTasks, releaseLease, removalDueElsewhere,
  type Change, type Task,
} from "@/lib/service-area-changes/store";
import db from "@/lib/db";

const WINDOW_MS = 40_000;
const PER_INSTANCE = 2;   // Bison sweeps at once per instance
const MAX_PARALLEL = 6;
const PRIORITY: Record<Task["kind"], number> = { search: 0, queue: 1, enrich: 2, full: 3 };

function baseUrl(): string {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return host ? `https://${host}` : "http://localhost:3000";
}

/** Fire-and-forget kick of the runner (continue one change, or pick the next). */
export function triggerServiceAreaRunner(changeId?: number): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const url = `${baseUrl()}/api/cron/service-area-jobs${changeId ? `?changeId=${changeId}` : ""}`;
  fetch(url, { headers: { "x-cron-secret": secret }, signal: AbortSignal.timeout(3000) }).catch(() => {});
}

/** Pick tasks to run together: search first, then queue, enrich, full; ≤2 Bison sweeps per instance, one DB task of each kind. */
function pickBatch(tasks: Task[]): Task[] {
  const sorted = [...tasks].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.attempts - b.attempts || a.id - b.id);
  const perInst = new Map<string, number>();
  const picked: Task[] = [];
  let queue = 0, enrich = 0;
  for (const t of sorted) {
    if (picked.length >= MAX_PARALLEL) break;
    if (t.kind === "queue") { if (queue >= 1) continue; queue++; picked.push(t); continue; }
    if (t.kind === "enrich") { if (enrich >= 1) continue; enrich++; picked.push(t); continue; }
    const n = perInst.get(t.instance!) ?? 0;
    if (n >= PER_INSTANCE) continue;
    perInst.set(t.instance!, n + 1);
    picked.push(t);
  }
  return picked;
}

async function taskCount(changeId: number, where: string, args: (string | number)[] = []): Promise<number> {
  return Number((await db.execute({ sql: `SELECT COUNT(*) AS n FROM sa_task WHERE change_id = ? AND ${where}`, args: [changeId, ...args] })).rows[0]?.n) || 0;
}
const enrichTask = (term: string) => ({ kind: "enrich" as const, instance: null, campaignId: null, campaignName: null, campaignKind: null, term, src: null, total: null });

/**
 * The check is complete only when every campaign was read in full and all three
 * queue sources were read — never just because nothing is pending (a set-up that
 * stopped half-way must not pass as a finished check).
 */
async function scanComplete(change: Change): Promise<string | null> {
  const live = change.campaigns.filter((c) => c.leads !== 0);
  const fullDone = await db.execute({ sql: "SELECT instance, campaign_id FROM sa_task WHERE change_id = ? AND kind = 'full' AND status = 'done'", args: [change.id] });
  const done = new Set(fullDone.rows.map((r) => `${r.instance}:${r.campaign_id}`));
  const missing = live.filter((c) => !done.has(`${c.instance}:${c.id}`));
  if (missing.length) return `${missing.length} campaign${missing.length === 1 ? " wasn't" : "s weren't"} read in full`;
  const queueDone = await taskCount(change.id, "kind = 'queue' AND status = 'done' AND term IS NULL");
  if (queueDone < 3) return "the nurture queue wasn't read in full";
  return null;
}

/** Scan bookkeeping: quick pass → enrich → full read → enrich + cross-check → review. Returns true if it moved anything forward. */
async function advanceScan(change: Change): Promise<boolean> {
  if (await taskCount(change.id, "kind IN ('search','queue') AND status = 'pending'")) return false;
  if (!change.quickDoneAt) {
    const enrich = await db.execute({ sql: "SELECT status FROM sa_task WHERE change_id = ? AND kind = 'enrich' AND term = 'quick'", args: [change.id] });
    if (!enrich.rows.length) { await addTasks(change.id, [enrichTask("quick")]); return true; }
    if (enrich.rows[0].status === "pending") return false;
    await patchChange(change.id, { quick_done_at: new Date().toISOString() });
    await logActivity("service-area", "quick-scan-done", { client_tag: change.clientTag, details: { change_id: change.id } });
    return true;
  }
  if (await taskCount(change.id, "kind = 'full' AND status = 'pending'")) return false;
  const fin = await db.execute({ sql: "SELECT status FROM sa_task WHERE change_id = ? AND kind = 'enrich' AND term = 'final'", args: [change.id] });
  if (!fin.rows.length) { await addTasks(change.id, [enrichTask("final")]); return true; }
  if (fin.rows[0].status === "pending") return false;
  // Failed parts are shown (and block approval) on the review page; a missing part is a set-up problem.
  const failed = await taskCount(change.id, "status = 'failed'");
  const gap = failed ? null : await scanComplete(change);
  if (gap) {
    await patchChange(change.id, { error: `The check isn't complete — ${gap}. Use “Check again”.` });
    return false;
  }
  await patchChange(change.id, { scan_done_at: new Date().toISOString(), status: "review", error: null }, ["scanning"]);
  await logActivity("service-area", "scan-done", { client_tag: change.clientTag, details: { change_id: change.id } });
  return true;
}

/** Removal-day top-up done (searches + queue + a database pass over new leads) → the removal itself. */
async function advanceTopup(change: Change): Promise<boolean> {
  if (await taskCount(change.id, "kind IN ('search','queue') AND status = 'pending'")) return false;
  const t = await db.execute({ sql: "SELECT status FROM sa_task WHERE change_id = ? AND kind = 'enrich' AND term = 'topup'", args: [change.id] });
  if (!t.rows.length) { await addTasks(change.id, [enrichTask("topup")]); return true; }
  if (t.rows[0].status === "pending") return false;
  await patchChange(change.id, { status: "removing", removal_started_at: new Date().toISOString() }, ["topup"]);
  return true;
}

async function runScan(change: Change, deadline: number, holder: string): Promise<boolean> {
  const tasks = pickBatch(await pendingTasks(change.id, ["search", "queue", "enrich", "full"]));
  if (!tasks.length) return change.status === "topup" ? advanceTopup(change) : advanceScan(change);
  const windowMs = Math.max(8_000, Math.min(WINDOW_MS, deadline - Date.now() - 8_000));
  const results = await Promise.allSettled(tasks.map((t) => runTaskWindow(change, t, windowMs, holder)));
  const lost = results.find((r) => r.status === "rejected");
  if (lost) throw (lost as PromiseRejectedResult).reason;
  await heartbeat(change.id, holder);
  const fresh = (await getChange(change.id)) ?? change;
  if (fresh.status === "topup") await advanceTopup(fresh); else await advanceScan(fresh);
  return true;
}

/** On the removal day: look again for leads that arrived in the removed places since the check. */
async function startTopup(change: Change): Promise<boolean> {
  const campaigns = await clientCampaigns(change.clientTag);
  const ok = await patchChange(change.id, { status: "topup", topup_started_at: new Date().toISOString() }, ["approved"]);
  if (!ok) return false;
  await addTasks(change.id, scanTasks(change, campaigns, true));
  await logActivity("service-area", "removal-day", { client_tag: change.clientTag, details: { change_id: change.id, campaigns: campaigns.length } });
  return true;
}

/** One step of whatever the change needs now. Returns true if it did work (so the loop goes on). */
async function step(change: Change, deadline: number, holder: string): Promise<boolean> {
  const now = Date.now();
  // Removal steps stop well inside the lease so the heartbeat after each keeps it.
  const short = Math.min(deadline - 15_000, now + 60_000);
  switch (change.status) {
    case "scanning": case "topup": return runScan(change, deadline, holder);
    case "approved":
      if (Date.parse(change.removalAt) > now) return false;
      return startTopup(change);
    case "removing": return runRemoval(change, short, holder);
    case "verifying":
      if (!change.verifyAfter || Date.parse(change.verifyAfter) > now) return false;
      return runVerify(change, short, holder);
    case "done": case "partial":
      if (!change.recheckAt || Date.parse(change.recheckAt) > now) return false;
      return runRecheck(change, short, holder);
    default: return false;
  }
}

/** Lease and work one change until the deadline. */
export async function runServiceAreaJobs(deadlineMs: number, changeId?: number): Promise<{ ran: number | null }> {
  const leased = await leaseChange(changeId);
  if (!leased) return { ran: null };
  const id = leased.id, holder = leased.leaseHolder!;
  let more = false, stepAside = false;
  try {
    while (Date.now() < deadlineMs - 10_000) {
      const c = await getChange(id);
      if (!c || c.leaseHolder !== holder) break;
      // A scan steps aside for another client's removal that's due.
      if (c.status === "scanning" && await removalDueElsewhere(id)) { stepAside = true; break; }
      const did = await step(c, deadlineMs, holder);
      await heartbeat(id, holder);
      if (!did) break;
      more = true;
    }
    // Work went through: an earlier run's problem is over. Not "the check isn't
    // complete" — that one stands until a check finishes or someone checks again.
    if (more) {
      await db.execute({
        sql: "UPDATE sa_change SET error = NULL WHERE id = ? AND error IS NOT NULL AND error NOT LIKE ? AND error NOT LIKE ?",
        args: [id, "%isn't complete%", "Setting up the check failed%"],
      });
    }
  } catch (e) {
    const msg = (e as Error).message || "failed";
    if ((e as Error).name !== "LeaseLost") {
      await patchChange(id, { error: msg.slice(0, 500) }).catch(() => {});
      await logError("service-area", `change-${id}`, msg, { change_id: id }).catch(() => {});
    }
  } finally {
    await releaseLease(id, holder).catch(() => {});
  }
  // Keep going back-to-back while this change has work right now; else look for the next one.
  const after = await getChange(id);
  const busy = !!after && (after.status === "scanning" || after.status === "topup" || after.status === "removing"
    || (after.status === "approved" && Date.parse(after.removalAt) <= Date.now())
    || (after.status === "verifying" && !!after.verifyAfter && Date.parse(after.verifyAfter) <= Date.now()));
  if (stepAside) triggerServiceAreaRunner();
  else if (busy && more) triggerServiceAreaRunner(id);
  else if (more) triggerServiceAreaRunner();
  return { ran: id };
}
