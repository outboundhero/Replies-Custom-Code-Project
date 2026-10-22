/**
 * Hard Reset — what it would do for a client, and whether it may.
 *
 * Built from the client's existing details the same way onboarding builds a new
 * client's campaigns (lib/onboarding/automations.ts `planCampaigns`), so the 12
 * new campaigns are exactly what a new client gets today: the current copy for
 * its type, Clay's settings, limits for its tier, Mon–Fri in its time zone.
 * The campaigns it archives are planned as if already gone, so the new ones get
 * the standard names.
 *
 * Active clients only (Client Tracker "Active", not on the churned list).
 */
import db from "@/lib/db";
import { listCampaigns, listTags, listSenderEmailsByTag, countCampaignSenders, getCampaignSchedule } from "@/lib/outboundhero-api";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import { BISON_INSTANCES, getInstanceLabel } from "@/lib/bison-instances-shared";
import { getClientInstances } from "@/lib/nurture/group-routing";
import { getCampaignMap } from "@/lib/nurture/campaign-map";
import { getChurnedTags } from "@/lib/churn";
import { fetchClientTrackerRecords } from "@/lib/google-sheets";
import { getClient } from "@/lib/onboarding/store";
import { planCampaigns, type AutomationContext, type AutomationInput, type CampaignPlan, type PreviewNote, type PreviewTable } from "@/lib/onboarding/automations";
import { isCampaignTimezone } from "@/lib/onboarding/campaign-plan";
import type { OnboardingTaskRow } from "@/lib/onboarding/store";
import { openChanges } from "@/lib/service-area-changes/store";
import { WORKING, latestReset, type HardReset, type OldCampaign } from "@/lib/hard-reset/store";

const gone = (status: string) => /archiv|delet/i.test(status);
const ROLE: Record<string, string> = { outboundhero: "B2B #1", cleaningoutbound: "B2C #1", facilityreach: "B2B #2", outboundclean: "B2C #2" };
export const instanceName = (key: string) => `${ROLE[key] ?? key} ${getInstanceLabel(key)}`;

export interface ResetPreview {
  tag: string;
  lines: string[];
  inputs: AutomationInput[];
  blockers: string[];
  tables: PreviewTable[];
  notes: PreviewNote[];
  /** Frozen into the reset when it starts. */
  archive: OldCampaign[];
  client: HardReset["client"] | null;
  plan: CampaignPlan | null;
}

/** Every campaign of the client that isn't archived yet, in all four instances (any name "TAG: …"). */
export async function currentCampaigns(tag: string): Promise<OldCampaign[]> {
  const out: OldCampaign[] = [];
  for (const inst of BISON_INSTANCES) {
    for (const c of await listCampaigns(inst.key, { search: tag, strict: true })) {
      if (extractTagFromCampaignName(c.name).toUpperCase() !== tag) continue;
      if (gone(String(c.status ?? ""))) continue;
      out.push({ instance: inst.key, id: c.id, name: c.name, status: String(c.status ?? "").toLowerCase(), leads: c.total_leads ?? 0 });
    }
  }
  return out;
}

/** Inboxes a reset puts on the new campaigns in one instance. */
export interface ClientInboxes {
  tagId: number | null;
  /** The ones to attach. */
  ids: number[];
  /** Of those, not Connected when read: Email Bison may refuse them, and they send again once reconnected. */
  offline: number[];
  /** Tagged with the client's tag but also Reserve or Burnt: left out. */
  setAside: number;
}

/**
 * Every inbox carrying the client's tag (LeadSync's rule — the same inboxes its
 * current campaigns send from), except those also tagged Reserve or Burnt:
 * released domains keep their old client tag.
 */
export async function clientInboxes(instance: string, tag: string): Promise<ClientInboxes> {
  const tagRow = (await listTags(instance)).find((x) => x.name.trim().toUpperCase() === tag);
  if (!tagRow) return { tagId: null, ids: [], offline: [], setAside: 0 };
  // Each row is checked for the tag too, so a list Email Bison didn't filter can't add anyone else's.
  const rows = (await listSenderEmailsByTag(instance, tagRow.id)).filter((x) => x.tags.some((t) => t.id === tagRow.id));
  const released = (x: (typeof rows)[number]) => x.tags.some((t) => /^(reserve|burnt)$/i.test(t.name.trim()));
  const keep = rows.filter((x) => !released(x));
  return {
    tagId: tagRow.id,
    ids: keep.map((x) => x.id).sort((a, b) => a - b),
    offline: keep.filter((x) => x.status.trim().toLowerCase() !== "connected").map((x) => x.id),
    setAside: rows.length - keep.length,
  };
}

/** How many inboxes the client's current campaigns in one instance have between them (the most on any one). */
export async function oldCampaignInboxes(instance: string, archive: OldCampaign[]): Promise<number> {
  let most = 0;
  for (const c of archive.filter((x) => x.instance === instance)) most = Math.max(most, await countCampaignSenders(instance, c.id));
  return most;
}

/** The client row onboarding's planner reads, made from the client's existing details. */
export function plannerContext(tag: string, client: HardReset["client"], params: Record<string, unknown>, by: string | null, fresh: boolean): AutomationContext {
  return {
    client: {
      client_tag: tag, client_name: client.name, plan_type: client.plan, group_num: client.group, campaign_timezone: client.timezone,
      start_date: "", domains_owner_email: null, inbox_owner_email: null, ops_owner_email: null, status: "active",
      created_by: null, created_at: "", updated_at: "",
    },
    task: { id: `hard-reset:${tag}` } as OnboardingTaskRow,
    params, by, mode: fresh ? "run" : "preview",
  };
}

/** The 12-campaign plan for a reset: the old campaigns planned as gone; earlier tries from the reset's own records. */
export function planNewCampaigns(tag: string, client: HardReset["client"], params: Record<string, unknown>, archive: OldCampaign[], built: HardReset["built"], by: string | null, fresh: boolean) {
  const ignoreIds = new Set(archive.map((c) => `${c.instance}:${c.id}`));
  // Newest first, the way onboarding's run records come back (its planner relies on that order).
  const history = async () => (built.length ? [{ results: [...built].reverse() }] : []);
  // Active clients onboarded before the Onboarding Form existed have no row there: their details are typed.
  return planCampaigns(plannerContext(tag, client, params, by, fresh), fresh, { ignoreIds, history, formOptional: true });
}

/** The client's details for the reset, and why it can't have one (if it can't). */
async function clientDetails(tag: string, archive: OldCampaign[]): Promise<{ client: HardReset["client"] | null; blockers: string[]; status: string | null }> {
  const blockers: string[] = [];
  const [inst, tracker, churned, oc] = await Promise.all([
    getClientInstances(tag),
    fetchClientTrackerRecords().catch(() => null),
    getChurnedTags(),
    getClient(tag).catch(() => null),
  ]);
  if (!tracker) blockers.push("Couldn't read the Client Tracker just now — try again in a moment.");
  const tr = tracker?.get(tag);
  const status = tr?.status?.trim() || null;
  if (churned.has(tag)) blockers.push(`${tag} is churned — a hard reset is for active clients only for now.`);
  else if (tracker && !tr) blockers.push(`${tag} isn't in the Client Tracker — a hard reset is for active clients there.`);
  else if (tracker && !/^active$/i.test(status ?? "")) blockers.push(`${tag}'s Client Tracker status is “${status ?? "blank"}” — a hard reset is for Active clients only for now.`);
  if (!inst) {
    blockers.push(`${tag} has no group on the Groups tab — its campaigns' instances aren't known.`);
    return { client: null, blockers, status };
  }
  // The time zone its campaigns send in now (its onboarding setting, else its current Google + Custom campaign's schedule).
  let timezone: string | null = oc?.campaign_timezone && isCampaignTimezone(oc.campaign_timezone) ? oc.campaign_timezone : null;
  if (!timezone) {
    const main = archive.find((c) => c.instance === inst.b2b && /: Google \+ Custom \(/.test(c.name)) ?? archive.find((c) => /: Google \+ Custom \(/.test(c.name));
    const sc = main ? await getCampaignSchedule(main.instance, main.id).catch(() => null) : null;
    if (sc && isCampaignTimezone(sc.timezone)) timezone = String(sc.timezone);
  }
  return {
    client: { group: inst.group, b2b: inst.b2b, b2c: inst.b2c, plan: tr?.plan || oc?.plan_type || null, name: tr?.company || oc?.client_name || null, timezone },
    blockers, status,
  };
}

/** Work going on for the client that a reset mustn't cut across. */
async function busyElsewhere(tag: string): Promise<string[]> {
  const out: string[] = [];
  const runs = await db.execute({
    sql: "SELECT automation FROM onboarding_task_run WHERE UPPER(client_tag) = ? AND finished_at IS NULL AND automation IN ('create_campaigns', 'allocate_domains')",
    args: [tag],
  }).catch(() => ({ rows: [] as Record<string, unknown>[] }));
  if (runs.rows.length) out.push(`An onboarding step (${runs.rows.map((r) => String(r.automation).replace(/_/g, " ")).join(", ")}) is running for ${tag} right now — wait for it to finish.`);
  const moves = await db.execute({ sql: "SELECT COUNT(*) AS n FROM move_job_task WHERE UPPER(client_tag) = ? AND status IN ('pending', 'running')", args: [tag] })
    .catch(() => ({ rows: [{ n: 0 }] as Record<string, unknown>[] }));
  if (Number(moves.rows[0]?.n) > 0) out.push(`A Move Leads job is moving ${tag}'s leads right now — wait for it to finish.`);
  const changes = await openChanges(tag).catch(() => []);
  const removing = changes.find((c) => ["topup", "removing", "verifying"].includes(c.status));
  if (removing) out.push(`Service area change #${removing.id} is removing ${tag}'s leads right now — wait for it to finish.`);
  return out;
}

/** The preview. `fresh` (right before starting) reads Email Bison and the sheets now, not from recent answers. */
export async function previewReset(tag: string, params: Record<string, unknown>, by: string | null, fresh = false): Promise<ResetPreview> {
  const T = tag.toUpperCase();
  const blockers: string[] = [];
  const tables: PreviewTable[] = [];
  const notes: PreviewNote[] = [];

  const open = await latestReset(T);
  if (open && (WORKING.includes(open.status) || open.status === "failed")) blockers.push(`Hard reset #${open.id} for ${T} isn't finished — finish or cancel it first.`);

  let archive: OldCampaign[] = [];
  try { archive = await currentCampaigns(T); }
  catch (e) { blockers.push(`Couldn't read ${T}'s campaigns in Email Bison (${(e as Error).message}) — try again.`); }

  const det = await clientDetails(T, archive);
  blockers.push(...det.blockers, ...(await busyElsewhere(T)));
  const client = det.client;

  // The 12 new campaigns (onboarding's planner — its inputs, checks and copy).
  let plan: CampaignPlan | null = null;
  if (client) {
    plan = await planNewCampaigns(T, client, params, archive, [], by, fresh);
    blockers.push(...plan.blockers);
    notes.push(...plan.notes);
  }

  // The campaigns it archives.
  tables.push({
    title: `Archived — ${archive.length} current campaign${archive.length === 1 ? "" : "s"}`,
    columns: ["Instance", "Campaign", "ID", "Status", "Leads"],
    rows: archive.length
      ? [...archive].sort((a, b) => a.instance.localeCompare(b.instance) || a.name.localeCompare(b.name)).map((c) => [instanceName(c.instance), c.name, `#${c.id}`, c.status, c.leads.toLocaleString()])
      : [["—", `${T} has no campaigns that aren't archived`, "", "", ""]],
  });
  if (plan?.rows.length) tables.push({ title: "Created — 12 new campaigns", columns: ["", "New campaign", "Per day (emails / leads)", "Mon–Fri", "Tags"], rows: plan.rows });

  // The inboxes that go on the new campaigns: everything tagged with the client's tag (LeadSync's rule), less released ones.
  const inboxRows: string[][] = [];
  if (client) {
    const counts: Record<string, number> = {};
    for (const inst of [client.b2b, client.b2c]) {
      try {
        const got = await clientInboxes(inst, T);
        const n = got.ids.length;
        counts[inst] = n;
        const extra = [
          got.offline.length ? `${got.offline.length.toLocaleString()} not connected right now` : "",
          got.setAside ? `${got.setAside.toLocaleString()} marked Reserve / Burnt left out` : "",
        ].filter(Boolean).join("; ");
        inboxRows.push([
          instanceName(inst),
          got.tagId == null ? `no ${T} tag` : `${n.toLocaleString()} inbox${n === 1 ? "" : "es"} tagged ${T}${extra ? ` (${extra})` : ""}`,
          n ? "all 6 new campaigns there" : "—",
        ]);
        if (!n) {
          const had = await oldCampaignInboxes(inst, archive);
          if (had) blockers.push(`No inbox in ${instanceName(inst)} carries the ${T} tag${got.setAside ? " (except ones marked Reserve / Burnt)" : ""}, but ${T}'s current campaigns there send from ${had.toLocaleString()} — the new ones would have none. Tag ${T}'s inboxes there first.`);
          else notes.push({ title: `${instanceName(inst)}: no inboxes`, text: `No inbox there carries the ${T} tag (and ${T}'s current campaigns there have none either), so its 6 new campaigns start without senders — they can't send until LeadSync adds domains.` });
        }
        if (got.setAside) notes.push({ title: `${instanceName(inst)}: Reserve / Burnt inboxes`, text: `${got.setAside.toLocaleString()} inbox${got.setAside === 1 ? "" : "es"} there still carry the ${T} tag but are marked Reserve or Burnt (released domains keep their old client tag) — they aren't put on the new campaigns.` });
      } catch (e) {
        blockers.push(`Couldn't read ${T}'s inboxes in ${instanceName(inst)} (${(e as Error).message}) — try again.`);
      }
    }
    if (client && Object.keys(counts).length === 2) client.inboxes = counts;
    tables.push({ title: "Domains", columns: ["Instance", "Inboxes", "Attached to"], rows: inboxRows });
  }

  // Nurture.
  if (client) {
    const map = await getCampaignMap(T).catch(() => []);
    const batches = Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM nurture_campaign_expansions WHERE UPPER(client_tag) = ?", args: [T] }).catch(() => ({ rows: [{ n: 0 }] }))).rows[0]?.n) || 0;
    const rows: string[][] = [];
    for (const inst of [client.b2b, client.b2c]) {
      for (const esp of ["google", "outlook", "segs"] as const) {
        const m = map.find((x) => x.bison_instance === inst && x.esp === esp);
        const lane = esp === "google" ? "Google + Custom" : esp === "outlook" ? "Outlook" : "SEGs";
        const newName = plan?.items.find((i) => i.instance === inst && i.slot.nurture && i.slot.lane === lane)?.name ?? `${T}: ${lane} [Nurture] (…)`;
        rows.push([instanceName(inst), lane, m ? `${m.campaign_name ?? "?"} (#${m.campaign_id})` : "not mapped", `${newName} (new)`]);
      }
    }
    const elsewhere = map.filter((m) => m.bison_instance !== client.b2b && m.bison_instance !== client.b2c).length;
    tables.push({ title: `Nurture — sends to the new nurture campaigns${batches ? `; ${batches} extra batch record${batches === 1 ? "" : "s"} cleared` : ""}`, columns: ["Instance", "Lane", "Now", "After the reset"], rows });
    if (elsewhere) notes.push({ title: "Nurture map", text: `${elsewhere} of ${T}'s nurture map entries point at an instance outside its group — they're replaced by the 6 above.` });
  }

  const created = plan?.items.length ?? 12;
  const lines = [
    `Creates ${T}'s ${created} new campaigns exactly as a new client gets them today — the current ${plan ? "" : "email "}copy for its type, the standard settings and limits, Mon–Fri in its time zone, tags New / Nurture + ${T}. They're drafts until they have leads.`,
    `Attaches every inbox tagged ${T} (the inboxes LeadSync gives its campaigns) to all 6 new campaigns in each of its two instances; any also marked Reserve or Burnt are left out. The domains, their redirects and whitelisting don't change.`,
    `Points nurture at the 6 new nurture campaigns and restarts its batch count. The 45-day wait and “never nurtured twice” stay — leads nurtured before aren't nurtured again.`,
    `Archives the ${archive.length} current campaign${archive.length === 1 ? "" : "s"} listed below — last, once everything new is ready, so ${T} keeps sending until then. Leads still in their sequences stop. Email Bison can't un-archive.`,
    "Then load leads into the new campaigns as usual — they launch on their own once they have leads and inboxes (the Go Live Date still applies). Their IDs show under Campaigns in Email Bison on this page.",
  ];
  return { tag: T, lines, inputs: plan?.inputs ?? [], blockers: [...new Set(blockers)], tables, notes, archive, client, plan };
}
