/**
 * Keep eligible clients' campaigns Active. For each active (non-churned, or
 * churned-but-not-past-churn-date) client, resume every Main + Nurture campaign
 * that is draft/paused but SENDABLE (>=1 lead AND >=1 connected sender inbox).
 * Campaigns with no leads or no inbox are left alone (they can't send).
 *
 * Idempotent: resuming an already-active campaign is a no-op. Run on a rotation
 * cursor + soft time budget by /api/cron/activate-campaigns.
 *
 * NOTE: there is deliberately NO "skip intentionally-paused" mechanism — per an
 * explicit product decision, eligible clients' sendable campaigns should always
 * be Active, so the cron re-activates anything paused.
 */
import { listCampaigns, resumeCampaign } from "@/lib/outboundhero-api";
import { getInstanceConfig } from "@/lib/bison-instances";
import { getAllClientInstances, type ClientInstances } from "@/lib/nurture/group-routing";
import { getChurnedTags } from "@/lib/churn";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import db from "@/lib/db";
import { logActivity, logError } from "@/lib/errors";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Fast "does this client have >=1 connected inbox on this instance?" — the
// sender-emails endpoint returns the client's tag-scoped pool (same for all
// their campaigns on the instance), so read only the first page.
async function hasConnectedInbox(inst: string, campaignId: number): Promise<boolean> {
  const { baseUrl, token } = getInstanceConfig(inst);
  const res = await fetch(`${baseUrl}/api/campaigns/${campaignId}/sender-emails?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) return false;
  const d = await res.json().catch(() => null);
  return ((d?.data ?? []) as Array<{ status?: string }>).some((s) => String(s.status).toLowerCase() === "connected");
}

export interface ActivateClientResult {
  tag: string;
  activated: number;
  alreadyActiveOrNoop: number;
  blocked: number;
  failed: number;
  error?: string;
}

/** Resume all sendable draft/paused Main+Nurture campaigns for one client. */
export async function activateSendableForClient(
  tag: string,
  ci: ClientInstances,
  opts: { dryRun?: boolean } = {},
): Promise<ActivateClientResult> {
  const TAG = tag.toUpperCase();
  const dry = !!opts.dryRun;
  const out: ActivateClientResult = { tag: TAG, activated: 0, alreadyActiveOrNoop: 0, blocked: 0, failed: 0 };
  const re = new RegExp(`^${esc(TAG)}\\s*:`, "i");
  const instances = Array.from(new Set([ci.b2b, ci.b2c]));

  for (const inst of instances) {
    let cs;
    try { cs = (await listCampaigns(inst, { statuses: ["draft", "paused"], search: TAG })).filter((c) => re.test(c.name || "")); }
    catch (e) { await logError("campaign-activation", `${TAG}/${inst}/list`, (e as Error).message); continue; }
    let inboxOk: boolean | null = null;
    for (const c of cs) {
      if ((extractTagFromCampaignName(c.name) || "").toUpperCase() !== TAG) continue;
      const leads = c.total_leads ?? 0;
      if (leads <= 0) { out.blocked++; continue; }
      if (inboxOk === null) { try { inboxOk = await hasConnectedInbox(inst, c.id); } catch { inboxOk = false; } }
      if (!inboxOk) { out.blocked++; continue; }
      if (dry) { out.activated++; continue; }
      try {
        const r = await resumeCampaign(inst, c.id);
        if (r.ok) out.activated++;
        else if (/not paused|already (active|running|launched)|only paused or draft/i.test(`${r.error ?? ""} ${JSON.stringify(r.raw ?? "")}`)) out.alreadyActiveOrNoop++;
        else { out.failed++; await logError("campaign-activation", `${TAG}/${inst}/${c.id}`, r.error ?? "resume failed"); }
      } catch (e) { out.failed++; await logError("campaign-activation", `${TAG}/${inst}/${c.id}`, (e as Error).message); }
    }
  }
  if (!dry && out.activated > 0) {
    await logActivity("campaign-activation", "activated", { client_tag: TAG, details: { activated: out.activated, blocked: out.blocked, failed: out.failed } });
  }
  return out;
}

// ── rotation cursor + sweep ───────────────────────────────────────────────────
let cursorReady: Promise<void> | null = null;
function ensureCursor(): Promise<void> {
  if (!cursorReady) {
    cursorReady = db.execute(
      "CREATE TABLE IF NOT EXISTS campaign_activation_cursor (client_tag TEXT PRIMARY KEY, last_run_at TEXT)",
    ).then(() => undefined).catch((e) => { cursorReady = null; throw e; });
  }
  return cursorReady;
}

export interface ActivationSweepResult {
  checked: number;
  budgetHit: boolean;
  totalActivated: number;
  results: ActivateClientResult[];
}

/**
 * Sweep eligible clients least-recently-run first, within a soft time budget.
 * Eligible = every client with a group mapping that is NOT churned-past-date
 * (getChurnedTags already excludes future-dated churns → they stay eligible).
 */
export async function runActivationSweep(opts: {
  dryRun?: boolean;
  limit?: number;
  maxMs?: number;
} = {}): Promise<ActivationSweepResult> {
  await ensureCursor();
  const dry = !!opts.dryRun;
  const started = Date.now();
  const budgetMs = opts.maxMs ?? 270_000;

  const all = await getAllClientInstances();
  const churned = await getChurnedTags();
  let tags = [...all.keys()].map((t) => t.toUpperCase()).filter((t) => !churned.has(t));

  const cur = await db.execute("SELECT client_tag, last_run_at FROM campaign_activation_cursor");
  const last = new Map<string, string>();
  for (const r of cur.rows as unknown as Array<{ client_tag: string; last_run_at: string }>) last.set(String(r.client_tag).toUpperCase(), r.last_run_at || "");
  tags.sort((a, b) => (last.get(a) ?? "").localeCompare(last.get(b) ?? ""));
  if (opts.limit && opts.limit > 0) tags = tags.slice(0, opts.limit);

  const results: ActivateClientResult[] = [];
  let budgetHit = false;
  for (const tag of tags) {
    if (Date.now() - started > budgetMs) { budgetHit = true; break; }
    const ci = all.get(tag);
    if (!ci) continue;
    try {
      const r = await activateSendableForClient(tag, ci, { dryRun: dry });
      results.push(r);
    } catch (e) {
      results.push({ tag, activated: 0, alreadyActiveOrNoop: 0, blocked: 0, failed: 0, error: (e as Error).message });
    }
    if (!dry) {
      await db.execute({
        sql: "INSERT INTO campaign_activation_cursor (client_tag, last_run_at) VALUES (?, datetime('now')) ON CONFLICT(client_tag) DO UPDATE SET last_run_at = datetime('now')",
        args: [tag],
      });
    }
  }
  return { checked: results.length, budgetHit, totalActivated: results.reduce((n, r) => n + r.activated, 0), results };
}
