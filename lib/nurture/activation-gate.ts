/**
 * Nurture 80% activation gate (fire-once).
 *
 * Problem: nurture campaigns share sender inboxes with the client's MAIN cold
 * campaigns, so nurture eats ~half the daily send capacity and mains crawl.
 * Fix: keep nurture OFF until 80% of the client's main-campaign leads are
 * contacted, then flip it ON once — and never re-evaluate that % again (so
 * topping up leads can't drop it back under 80% and shut nurture off).
 *
 * "Fired" = the client tag is present in Turso `nurture_activation`. Once fired,
 * the gate skips it forever. Every other nurture activation path consults
 * `isFired()` so nothing turns a client's nurture on before it's fired
 * (lib/nurture/enable-sending.ts, lib/nurture/campaign-expansion.ts).
 *
 * Per run (see the nurture-activation-gate cron), for each active non-churned tag:
 *   - already fired            → skip
 *   - main completion >= 80%   → FIRE: record + activate ready nurture
 *   - main completion <  80%   → pause any currently-sending nurture campaign
 */
import { getAllClientInstances } from "@/lib/nurture/group-routing";
import { getChurnedTags } from "@/lib/churn";
import { mainCompletion, listNurtureCampaigns, isOn } from "@/lib/nurture/campaign-inventory";
import { pauseCampaign } from "@/lib/outboundhero-api";
import { autoActivateReadyCampaigns } from "@/lib/nurture/enable-sending";
import {
  ensureActivationTables,
  isFired,
  markFired,
  recordGateCheck as recordCheck,
  loadLastGateChecks as loadLastChecked,
} from "@/lib/nurture/activation-state";
import { logActivity, logError } from "@/lib/errors";

export const ACTIVATION_THRESHOLD = 0.8;
export { isFired };

export type GateAction =
  | "already-fired"        // fire-once: skipped
  | "fired-activated"      // crossed 80% → recorded + activated ready nurture
  | "fired-no-mains"       // no loaded main campaigns → treated as done, fired
  | "paused"               // under 80% → paused live nurture
  | "left-off"             // under 80% → nothing was live to pause
  | "error";

export interface GateOutcome {
  tag: string;
  action: GateAction;
  pct: number | null;      // main completion (null if not evaluated)
  total: number;
  contacted: number;
  paused?: number;         // nurture campaigns paused this run
  activated?: number;      // nurture campaigns activated this run
  error?: string;
}

/**
 * Evaluate ONE client tag. `dryRun` computes the outcome + what it WOULD do
 * (pause/activate counts) without mutating Bison or the gate tables.
 */
export async function evaluateTag(tag: string, opts?: { dryRun?: boolean }): Promise<GateOutcome> {
  const TAG = tag.toUpperCase();
  const dry = !!opts?.dryRun;
  const out: GateOutcome = { tag: TAG, action: "error", pct: null, total: 0, contacted: 0 };
  try {
    if (await isFired(TAG)) {
      out.action = "already-fired";
      if (!dry) await recordCheck(TAG);
      return out;
    }

    const mc = await mainCompletion(TAG);
    out.pct = mc.pct;
    out.total = mc.total;
    out.contacted = mc.contacted;

    if (mc.pct >= ACTIVATION_THRESHOLD) {
      // FIRE (permanent). Record first, then best-effort activate ready nurture.
      out.action = mc.counted === 0 ? "fired-no-mains" : "fired-activated";
      if (!dry) {
        await markFired(TAG, mc.total, mc.contacted);
        try {
          const act = await autoActivateReadyCampaigns(TAG);
          out.activated = act.activated.length;
        } catch (e) {
          await logError("nurture-activation-gate", `${TAG}/activate`, (e as Error).message);
        }
        await recordCheck(TAG);
        await logActivity("nurture-activation-gate", "fired", {
          client_tag: TAG,
          details: { pct: mc.pct, total: mc.total, contacted: mc.contacted, counted: mc.counted, activated: out.activated ?? 0 },
        });
      }
      return out;
    }

    // UNDER 80% — pause any currently-sending nurture campaign (leave draft/paused).
    const nurts = await listNurtureCampaigns(TAG);
    const on = nurts.filter((n) => isOn(n.status));
    out.action = on.length ? "paused" : "left-off";
    if (!dry) {
      let paused = 0;
      for (const n of on) {
        const r = await pauseCampaign(n.instance, n.id);
        if (r.ok) paused++;
        else await logError("nurture-activation-gate", `${TAG}/${n.instance}/${n.id}/pause`, r.error ?? "pause failed");
      }
      out.paused = paused;
      out.action = paused ? "paused" : "left-off";
      await recordCheck(TAG);
      if (paused) {
        await logActivity("nurture-activation-gate", "paused-under-threshold", {
          client_tag: TAG,
          details: { pct: mc.pct, total: mc.total, contacted: mc.contacted, paused },
        });
      }
    } else {
      out.paused = on.length;
    }
    return out;
  } catch (e) {
    out.action = "error";
    out.error = (e as Error).message;
    if (!dry) await logError("nurture-activation-gate", `${TAG}/evaluate`, out.error);
    return out;
  }
}

export interface GateRunResult {
  checked: number;
  softBudgetHit: boolean;
  results: GateOutcome[];
}

/**
 * Sweep all active, non-churned client tags, oldest-checked-first (so each cron
 * tick advances a different slice), bounded by a soft time budget. `dryRun`
 * evaluates without mutating. `limit` caps how many tags this run touches.
 */
export async function runActivationGate(opts?: {
  dryRun?: boolean;
  maxMs?: number;
  limit?: number;
}): Promise<GateRunResult> {
  await ensureActivationTables();
  const dry = !!opts?.dryRun;
  const startedAt = Date.now();
  const softBudgetMs = opts?.maxMs ?? 240_000;

  const all = await getAllClientInstances();
  const churned = await getChurnedTags();
  let tags = [...all.keys()].filter((t) => !churned.has(t.toUpperCase()));

  const lastChecked = await loadLastChecked();
  tags.sort((a, b) =>
    (lastChecked.get(a.toUpperCase()) ?? "").localeCompare(lastChecked.get(b.toUpperCase()) ?? ""),
  );
  if (opts?.limit && opts.limit > 0) tags = tags.slice(0, opts.limit);

  const results: GateOutcome[] = [];
  let softBudgetHit = false;
  for (const tag of tags) {
    if (!dry && Date.now() - startedAt > softBudgetMs) {
      softBudgetHit = true;
      break;
    }
    results.push(await evaluateTag(tag, { dryRun: dry }));
  }
  return { checked: results.length, softBudgetHit, results };
}
