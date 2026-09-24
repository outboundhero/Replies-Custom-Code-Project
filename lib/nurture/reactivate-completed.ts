/**
 * Revive COMPLETED nurture campaigns.
 *
 * Bison marks a campaign "completed" once every lead in it has finished the
 * sequence. A completed campaign STOPS — any nurture leads routed into it after
 * that point (sequence-finished leads from the mains) never send. That silently
 * kills nurture for the client.
 *
 * Fix: continuously find canonical [Nurture] campaigns that have gone
 * "completed" and revive them so they keep accepting + sending new leads.
 *
 * IMPORTANT — Bison won't resume a completed campaign directly:
 *   PATCH /resume on a completed campaign → 400 "This campaign is not paused.
 *   Only paused or draft campaigns can be resumed / launched."
 * So the revive is a two-step: pause (completed → paused) then resume
 * (paused → queued/active). Verified live.
 *
 * Scope: only LIVE (go-live passed), non-churned clients — a pre-launch or
 * churned client's nurture must stay off. Fails CLOSED on a go-live read error
 * (skips the sweep that tick) so we never revive a pre-launch client's nurture.
 */
import { listCampaigns, pauseCampaign, resumeCampaign } from "@/lib/outboundhero-api";
import { BISON_INSTANCES } from "@/lib/bison-instances";
import { isCanonicalNurtureCampaign } from "@/lib/nurture/esp";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import { getChurnedTags } from "@/lib/churn";
import { fetchNotYetLiveTags, NURTURE_GOLIVE_LAG_DAYS } from "@/lib/google-sheets";
import { logActivity, logError } from "@/lib/errors";

type Camp = { id: number; name?: string | null; status?: string | null };

/**
 * Revive a single completed campaign: pause (completed → paused) then resume
 * (paused → queued/active). If the pause reports it wasn't completed after all
 * (someone already revived it), the resume still lands it active — idempotent.
 */
export async function reviveCompletedCampaign(
  instance: string,
  campaignId: number,
): Promise<{ ok: boolean; error?: string }> {
  const p = await pauseCampaign(instance, campaignId);
  if (!p.ok) return { ok: false, error: `pause: ${p.error ?? "failed"}` };
  const r = await resumeCampaign(instance, campaignId);
  if (!r.ok) return { ok: false, error: `resume: ${r.error ?? "failed"}` };
  return { ok: true };
}

export interface ReactivateResult {
  scanned: number;    // canonical nurture campaigns seen
  completed: number;  // of those, currently "completed"
  revived: number;
  skipped: number;    // churned / not-live client
  failed: number;
  details: Array<{ instance: string; id: number; name: string; tag: string | null; outcome: string }>;
}

/**
 * Sweep every instance for completed canonical nurture campaigns and revive
 * those belonging to live, non-churned clients.
 *
 * @param opts.campaignsByInstance  reuse a caller's already-fetched lists (the
 *   refresh-nurture-campaigns cron already pages every instance) to avoid a
 *   second round of list calls. Must be the FULL campaign list per instance
 *   (any status), keyed by instance key.
 * @param opts.dryRun  compute what WOULD be revived without touching Bison.
 */
export async function reactivateCompletedNurture(opts?: {
  campaignsByInstance?: Record<string, Camp[]>;
  dryRun?: boolean;
}): Promise<ReactivateResult> {
  const dry = !!opts?.dryRun;
  const res: ReactivateResult = { scanned: 0, completed: 0, revived: 0, skipped: 0, failed: 0, details: [] };

  // Gather campaigns per instance (reuse caller's list if provided).
  const byInstance: Record<string, Camp[]> = {};
  if (opts?.campaignsByInstance) {
    Object.assign(byInstance, opts.campaignsByInstance);
  } else {
    await Promise.all(
      BISON_INSTANCES.map(async (i) => {
        try { byInstance[i.key] = await listCampaigns(i.key); }
        catch (e) { await logError("nurture-reactivate", `${i.key}/list`, (e as Error).message); byInstance[i.key] = []; }
      }),
    );
  }

  // Client-level gates, loaded once. Fail closed on the go-live read.
  const churned = await getChurnedTags();
  let notLive: Set<string>;
  try {
    notLive = await fetchNotYetLiveTags(NURTURE_GOLIVE_LAG_DAYS);
  } catch (e) {
    await logError("nurture-reactivate", "golive", `skipping revive this tick — ${(e as Error).message}`);
    return res;
  }

  for (const [instance, camps] of Object.entries(byInstance)) {
    for (const c of camps) {
      if (!isCanonicalNurtureCampaign(c.name || "")) continue;
      res.scanned++;
      if (String(c.status).toLowerCase() !== "completed") continue;
      res.completed++;

      const tag = ((extractTagFromCampaignName(c.name) || "").toUpperCase()) || null;
      if (tag && (churned.has(tag) || notLive.has(tag))) {
        res.skipped++;
        res.details.push({ instance, id: c.id, name: c.name || "", tag, outcome: churned.has(tag) ? "skip-churned" : "skip-not-live" });
        continue;
      }

      if (dry) {
        res.details.push({ instance, id: c.id, name: c.name || "", tag, outcome: "would-revive" });
        continue;
      }

      const rv = await reviveCompletedCampaign(instance, c.id);
      if (rv.ok) {
        res.revived++;
        res.details.push({ instance, id: c.id, name: c.name || "", tag, outcome: "revived" });
        await logActivity("nurture-reactivate", "revived-completed", {
          client_tag: tag ?? undefined,
          details: { instance, campaign_id: c.id, name: c.name },
        });
      } else {
        res.failed++;
        res.details.push({ instance, id: c.id, name: c.name || "", tag, outcome: `fail: ${rv.error}` });
        await logError("nurture-reactivate", `${tag}/${instance}/${c.id}`, rv.error || "revive failed");
      }
    }
  }

  return res;
}
