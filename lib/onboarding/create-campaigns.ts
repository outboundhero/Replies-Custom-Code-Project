/**
 * Creating ONE of a new client's campaigns (onboarding step 2).
 *
 * The campaign is a copy Email Bison itself makes of the master's campaign
 * (so subjects, variables, spintax, limits and schedule arrive exactly as they
 * are), then: renamed, the place names in the bodies swapped
 * (lib/onboarding/campaign-copy.ts), the schedule moved to the client's
 * timezone, and the tags set. Every write is read back and compared. A copy
 * that doesn't check out is never left under the client's real name:
 *   • nothing changed in it yet  → it is deleted;
 *   • its content was written    → it is renamed "CHECK COPY — …" and kept, so
 *     what went wrong can be looked at, and a re-run makes a fresh one.
 * Nothing here launches a campaign — copies are drafts.
 */
import {
  duplicateCampaignOnce, updateCampaign, deleteCampaign, getSequenceSteps, updateSequenceSteps,
  getCampaignSchedule, setCampaignSchedule, listTags, createTag, setCampaignTags, getCampaignWithTags,
  type BisonTag,
} from "@/lib/outboundhero-api";
import { localizeSteps, variablesIn, type Place } from "@/lib/onboarding/campaign-copy";

export interface MasterStep {
  id: number; order: number; email_subject: string; email_body: string;
  wait_in_days: number; thread_reply: boolean; variant?: boolean; variant_from_step_id?: number | null;
}
export interface CreateOne {
  instance: string;
  /** The new campaign's exact name. */
  name: string;
  nurture: boolean;
  clientTag: string;
  master: { id: number; name: string; steps: MasterStep[] };
  masterPlace: Place;
  target: Place;
  timezone: string;
}
export interface CreatedCampaign {
  instance: string; name: string; state: "created" | "failed";
  campaignId: number | null; note?: string;
}

export const CHECK_PREFIX = "CHECK COPY — ";
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const hm = (v: unknown) => String(v ?? "").slice(0, 5);

function readSteps(raw: unknown): { sequenceId: number; steps: MasterStep[] } | null {
  const r = raw as { sequence_id?: unknown; sequence_steps?: MasterStep[] } | null;
  if (!r || typeof r.sequence_id !== "number" || !Array.isArray(r.sequence_steps)) return null;
  return { sequenceId: r.sequence_id, steps: [...r.sequence_steps].sort((a, b) => a.order - b.order) };
}

/** The first way two step lists differ in what a recipient would get, or null when they match. */
function firstDifference(got: MasterStep[], want: { email_subject: string; email_body: string; wait_in_days: number; thread_reply: boolean }[]): string | null {
  if (got.length !== want.length) return `${got.length} emails instead of ${want.length}`;
  for (let i = 0; i < want.length; i++) {
    if (got[i].email_subject !== want[i].email_subject) return `email ${i + 1}: the subject changed`;
    if (got[i].email_body !== want[i].email_body) {
      return variablesIn(got[i].email_body).join() !== variablesIn(want[i].email_body).join()
        ? `email ${i + 1}: the variables in the body changed` : `email ${i + 1}: the body isn't what was written`;
    }
    if (Number(got[i].wait_in_days) !== Number(want[i].wait_in_days)) return `email ${i + 1}: the wait changed`;
    if (!!got[i].thread_reply !== !!want[i].thread_reply) return `email ${i + 1}: reply-in-thread changed`;
  }
  return null;
}

/** Tags of one instance, read once per run and added to as tags are created. */
export type TagCache = Map<string, BisonTag[]>;
async function tagId(cache: TagCache, instance: string, name: string): Promise<number | null> {
  if (!cache.has(instance)) cache.set(instance, await listTags(instance));
  const list = cache.get(instance)!;
  const hit = list.find((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (hit) return hit.id;
  const made = await createTag(instance, name);
  if (made) list.push(made);
  return made?.id ?? null;
}

export async function createCampaignFromMaster(job: CreateOne, tags: TagCache): Promise<CreatedCampaign> {
  const { instance, name } = job;
  const failed = (note: string, campaignId: number | null = null): CreatedCampaign => ({ instance, name, state: "failed", campaignId, note });
  /** An untouched copy is simply removed. */
  const drop = async (id: number, note: string) => {
    const gone = await deleteCampaign(instance, id).catch(() => ({ ok: false }));
    return failed(gone.ok ? note : `${note} The unused copy (#${id}) couldn't be removed — delete it in Email Bison.`, gone.ok ? null : id);
  };
  /** A copy whose content was written is kept for inspection, but not under the client's name. */
  const park = async (id: number, note: string) => {
    const renamed = await updateCampaign(instance, id, { name: `${CHECK_PREFIX}${name}` }).catch(() => false);
    return failed(`${note} The copy is kept as #${id}${renamed ? ` “${CHECK_PREFIX}${name}”` : " — rename or delete it in Email Bison before running again"}.`, id);
  };

  // 1. Email Bison makes the copy.
  const clone = await duplicateCampaignOnce(instance, job.master.id);
  if (!clone) return failed(`Email Bison didn't copy the master #${job.master.id}.`);
  const id = clone.id;

  // 2. Its own name, and the emails it arrived with must be the master's.
  if (!(await updateCampaign(instance, id, { name }))) return drop(id, "The copy couldn't be renamed.");
  const arrived = readSteps(await getSequenceSteps(instance, id));
  if (!arrived) return drop(id, "The copy's emails couldn't be read.");
  const strange = firstDifference(arrived.steps, job.master.steps);
  if (strange) return drop(id, `The copy doesn't match its master (${strange}).`);

  // 3. Place names — bodies only; subjects go back exactly as they came.
  const loc = localizeSteps(arrived.steps, job.masterPlace, job.target);
  if (loc.problems.length) return drop(id, `The copy rules refused it: ${loc.problems[0]}`);
  const write = await updateSequenceSteps(instance, arrived.sequenceId, name, loc.steps.map((s) => ({
    id: s.id, email_subject: s.email_subject, order: s.order, email_body: s.email_body,
    wait_in_days: s.wait_in_days, variant: !!s.variant, thread_reply: !!s.thread_reply,
    ...(s.variant && s.variant_from_step_id ? { variant_from_step_id: s.variant_from_step_id } : {}),
  })));
  if (!write.ok) return park(id, `Email Bison refused the edited emails${write.message ? ` (${write.message})` : ""}.`);
  const saved = readSteps(await getSequenceSteps(instance, id));
  if (!saved) return park(id, "The emails couldn't be read back after editing.");
  const wrong = firstDifference(saved.steps, loc.steps);
  if (wrong) return park(id, `What Email Bison saved isn't what was written (${wrong}).`);

  // 4. Schedule: same days and hours, the client's timezone.
  const sched = await getCampaignSchedule(instance, id);
  if (!sched) return park(id, "The copy has no schedule to set the timezone on.");
  const payload = { ...Object.fromEntries(DAYS.map((d) => [d, !!sched[d]])), start_time: hm(sched.start_time), end_time: hm(sched.end_time), timezone: job.timezone, save_as_template: false };
  if (!(await setCampaignSchedule(instance, id, payload))) return park(id, "The schedule's timezone couldn't be set.");
  const after = await getCampaignSchedule(instance, id);
  if (!after || after.timezone !== job.timezone || hm(after.start_time) !== payload.start_time || hm(after.end_time) !== payload.end_time || DAYS.some((d) => !!after[d] !== !!sched[d])) {
    return park(id, "The schedule Email Bison saved isn't the one that was set.");
  }

  // 5. Tags: "New" or "Nurture" plus the client's own — and none of the master's.
  const want = [job.nurture ? "Nurture" : "New", job.clientTag];
  const wantIds: number[] = [];
  for (const n of want) {
    const t = await tagId(tags, instance, n).catch(() => null);
    if (t == null) return park(id, `The tag “${n}” couldn't be found or created.`);
    wantIds.push(t);
  }
  const now = await getCampaignWithTags(instance, id);
  if (!now) return park(id, "The copy couldn't be read to set its tags.");
  const extra = now.tags.filter((t) => !wantIds.includes(t.id)).map((t) => t.id);
  const missing = wantIds.filter((t) => !now.tags.some((x) => x.id === t));
  if (!(await setCampaignTags(instance, "remove", extra, [id])).ok || !(await setCampaignTags(instance, "attach", missing, [id])).ok) {
    return park(id, "The tags couldn't be set.");
  }
  const tagged = await getCampaignWithTags(instance, id);
  const have = (tagged?.tags ?? []).map((t) => t.id).sort().join();
  if (!tagged || have !== [...wantIds].sort().join() || tagged.name !== name) return park(id, "The tags or name Email Bison saved aren't the ones that were set.");

  return { instance, name, state: "created", campaignId: id };
}
