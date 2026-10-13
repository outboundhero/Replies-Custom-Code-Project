/**
 * Automations behind the checklist's Run buttons.
 *
 * Every automation can PREVIEW exactly what it would do (changes nothing) and
 * RUN it. Runs are recorded in onboarding_task_run by the API route; a
 * successful run marks its task Done. Tasks whose automation isn't built yet
 * (AUTOMATION_META.built = false) are completed by hand and never reach here.
 */
import { dmBySlackIds, postToChannel } from "@/lib/slack";
import {
  getSetting, setClientGroup, listOnboardingUsers, lastFailedAttempt,
  type OnboardingClientRow, type OnboardingTaskRow,
} from "@/lib/onboarding/store";
import { GROUP_META, AUTOMATION_META, groupText, fmtDate } from "@/lib/onboarding/ui";
import { groupForStartDate } from "@/lib/onboarding/generate";
import { withCache, nsVersion } from "@/lib/server-cache";
import { fetchNewClientInfo, fetchOnboardingWebsites, type NewClientInfoRow } from "@/lib/google-sheets";
import { listCampaigns, getSequenceSteps, getCampaignSchedule } from "@/lib/outboundhero-api";
import { previewOnboardingAllocation, runOnboardingAllocation, rememberAllocationPlan, type AllocationSide, type AllocationPlan } from "@/lib/leadsync";
import type { BisonInstanceKey } from "@/lib/bison-instances-shared";
import { localizeSteps, placeProblems, defaultArea, type Place } from "@/lib/onboarding/campaign-copy";
import { createCampaignFromMaster, CHECK_PREFIX, type MasterStep, type TagCache } from "@/lib/onboarding/create-campaigns";
import {
  CAMPAIGN_SLOTS, GROUP_INSTANCES, TIMEZONE_OPTIONS, campaignName, slotKey, slotOfName, parseMasterSettings,
  parsePlace, regionByAny, timezoneForState, type CampaignSlot,
} from "@/lib/onboarding/campaign-plan";

export interface AutomationInput {
  key: string; label: string; type: "group" | "text" | "select";
  value: number | string | null; hint?: string; placeholder?: string;
  options?: { value: string; label: string }[];
}
export interface PreviewTable { title: string; columns: string[]; rows: string[][] }
export interface PreviewNote { title: string; text: string }
export interface AutomationPreview {
  title: string;
  /** What will happen, in order. */
  lines: string[];
  /** The exact message / payload, when there is one. */
  message?: string;
  inputs: AutomationInput[];
  /** Reasons it can't run yet (empty = ready). */
  blockers: string[];
  /** What would be created / changed, row by row. */
  tables?: PreviewTable[];
  /** Longer text shown as written (e.g. the copy lines that change). */
  notes?: PreviewNote[];
}
export interface RunOutcome {
  ok: boolean; summary: string; result?: unknown;
  /** A batch went through and there is more to do — the caller runs again; the step isn't Done yet. */
  more?: boolean;
}
export interface AutomationContext {
  client: OnboardingClientRow;
  task: OnboardingTaskRow;
  params: Record<string, unknown>;
  by: string | null;
}
interface Automation {
  preview(ctx: AutomationContext): Promise<AutomationPreview>;
  run(ctx: AutomationContext): Promise<RunOutcome>;
}

// ── 1. Slack Outreachify to onboard new clients ─────────────────────────────

export const OUTREACHIFY_SLACK_SETTING = "outreachify_slack";
interface SlackDest { id: string; label: string; kind: "person" | "channel" }

/**
 * Where the "Slack Outreachify" message goes: the IDs saved in onboarding
 * settings (channel IDs like C0123…, or member IDs like U0123… for a DM). Until
 * that's set, any onboarding user whose name mentions Outreachify is DM'd.
 */
export async function outreachifyDestinations(): Promise<SlackDest[]> {
  const users = await listOnboardingUsers();
  const saved = await getSetting(OUTREACHIFY_SLACK_SETTING);
  if (saved != null) {
    return saved.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean).map((id) => {
      const person = /^[UW][A-Z0-9]{6,}$/.test(id);
      const user = users.find((u) => u.slack_member_id === id);
      return { id, kind: person ? "person" : "channel", label: user ? `${user.name} (DM)` : person ? `${id} (DM)` : `${id} (channel)` } as SlackDest;
    });
  }
  return users
    .filter((u) => /outreachify/i.test(u.name) && u.slack_member_id)
    .map((u) => ({ id: u.slack_member_id as string, kind: "person" as const, label: `${u.name} (DM)` }));
}

function chosenGroup(ctx: AutomationContext): 1 | 2 | null {
  const g = Number(ctx.params.group ?? ctx.client.group_num);
  return g === 1 || g === 2 ? g : null;
}

function outreachifyMessage(ctx: AutomationContext, group: 1 | 2): string {
  const c = ctx.client;
  const m = GROUP_META[group];
  return [
    `:rocket: *New client to onboard — ${c.client_tag}*${c.client_name ? ` (${c.client_name})` : ""}`,
    `• Group: *${m.label}* — B2B #${group} ${m.b2b} + B2C #${group} ${m.b2c}`,
    ...(c.plan_type ? [`• Plan: ${c.plan_type}`] : []),
    `• Start date: ${fmtDate(c.start_date)}`,
    `Please add *${c.client_tag}* to *${m.label}*.`,
    `_Sent${ctx.by ? ` by ${ctx.by}` : ""} from the Reply Router onboarding checklist._`,
  ].join("\n");
}

/** The start-date rule in words: 1st → Group 2, 15th → Group 1, else no default. */
function groupRuleHint(startDate: string): string {
  const byRule = groupForStartDate(startDate);
  return byRule
    ? `Starts ${fmtDate(startDate)} — clients starting on the ${byRule === 2 ? "1st" : "15th"} go to Group ${byRule}.`
    : `Starts ${fmtDate(startDate)} — not the 1st or the 15th, so there's no default group. Choose one.`;
}

/** The destinations this exact message hasn't reached yet (all of them, unless the last attempt got part-way). */
async function stillToSend(taskId: string, dests: SlackDest[], text: string): Promise<SlackDest[]> {
  const last = await lastFailedAttempt(taskId);
  const done = last && last.text === text && Array.isArray(last.sentIds) ? new Set(last.sentIds.map(String)) : new Set<string>();
  return dests.filter((d) => !done.has(d.id));
}

const slackOutreachify: Automation = {
  async preview(ctx) {
    const group = chosenGroup(ctx);
    const dests = await outreachifyDestinations();
    const blockers: string[] = [];
    if (!group) blockers.push("Choose Group 1 or Group 2.");
    if (!dests.length) blockers.push("No Slack destination is set for Outreachify — an admin can add it under Onboarding → Team.");
    // A retry only sends to the places the last attempt didn't reach.
    const pending = group ? await stillToSend(ctx.task.id, dests, outreachifyMessage(ctx, group)) : dests;
    const reached = dests.filter((d) => !pending.includes(d));
    return {
      title: "Slack Outreachify to onboard new clients",
      lines: [
        `Sends this message to: ${pending.length ? pending.map((d) => d.label).join(", ") : "—"}`,
        ...(reached.length ? [`Already delivered to ${reached.map((d) => d.label).join(", ")} on the last attempt — it isn't sent there again.`] : []),
        `Saves the group on ${ctx.client.client_tag}: ${group ? groupText(group) : "not chosen yet"}`,
        "Marks this step Done.",
      ],
      message: group ? outreachifyMessage(ctx, group) : undefined,
      inputs: [{ key: "group", label: "Group", type: "group", value: group, hint: groupRuleHint(ctx.client.start_date) }],
      blockers,
    };
  },
  async run(ctx) {
    const group = chosenGroup(ctx);
    if (!group) return { ok: false, summary: "No group chosen." };
    const dests = await outreachifyDestinations();
    if (!dests.length) return { ok: false, summary: "No Slack destination is set for Outreachify." };
    const text = outreachifyMessage(ctx, group);
    // Saved before anything is sent: if this were to fail after Slack accepted
    // the message, the step would look failed and be run — and sent — again.
    await setClientGroup(ctx.client.client_tag, group);
    const pending = await stillToSend(ctx.task.id, dests, text);
    const failed: string[] = [];
    const sent: string[] = [];
    // Everything this message has reached, across attempts — a retry skips these.
    const sentIds = dests.filter((d) => !pending.includes(d)).map((d) => d.id);
    for (const d of pending) {
      if (d.kind === "person") {
        const r = await dmBySlackIds([d.id], text);
        if (r.ok) { sent.push(d.label); sentIds.push(d.id); } else failed.push(`${d.label}: ${r.failed.map((f) => f.error).join("; ")}`);
      } else {
        const r = await postToChannel(d.id, text);
        if (r.ok) { sent.push(d.label); sentIds.push(d.id); } else failed.push(`${d.label}: ${r.error}`);
      }
    }
    // The step counts only when every destination got the message.
    if (failed.length) {
      return { ok: false, summary: `Slack didn't accept the message for ${failed.join(" | ")}${sent.length ? ` (delivered to ${sent.join(", ")})` : ""}`, result: { group, text, sentIds, sent, failed } };
    }
    const all = dests.map((d) => d.label).join(", ");
    return { ok: true, summary: `Sent ${ctx.client.client_tag} → ${GROUP_META[group].label} to ${all}`, result: { group, text, sentIds, sent } };
  },
};

// ── 2. Create email campaigns ───────────────────────────────────────────────
// Each new campaign is a copy of the master client's campaign in the same slot
// and instance, with the master's place names swapped for this client's
// (lib/onboarding/campaign-copy.ts, lib/onboarding/create-campaigns.ts).
// Creating is OFF unless ONBOARDING_CREATE_CAMPAIGNS=1 is set on the server —
// it is switched on once the masters are confirmed and one test has been run
// in Email Bison. Until then this is a preview.

export const CAMPAIGN_MASTERS_SETTING = "campaign_masters";
/** Server-side switch for actually creating campaigns (the preview always works). */
export const campaignCreationEnabled = () => process.env.ONBOARDING_CREATE_CAMPAIGNS === "1";
const NOT_SWITCHED_ON =
  "Creating the campaigns isn't switched on yet — it waits for the master campaigns to be confirmed and one test in Email Bison. This is a preview; complete the step by hand for now.";

interface MasterCampaign { id: number; name: string; status: string; slot: CampaignSlot; steps: MasterStep[]; schedule: Record<string, unknown> | null }
const gone = (status: string) => /archiv|delet/i.test(status);

/** The master client's live campaigns in one instance, by slot (a slot can hold none, one or several). */
function loadMasterCampaigns(instance: BisonInstanceKey, tag: string, fresh: boolean): Promise<Map<string, MasterCampaign[]>> {
  const read = async () => {
    const out = new Map<string, MasterCampaign[]>();
    for (const c of await listCampaigns(instance, { search: tag, strict: true })) {
      const slot = slotOfName(c.name, tag);
      if (!slot || gone(c.status)) continue;
      const [steps, schedule] = await Promise.all([getSequenceSteps(instance, c.id), getCampaignSchedule(instance, c.id)]);
      // A failed read throws, so it is reported now and never cached as "no emails".
      if (!steps) throw new Error(`couldn't read the emails of #${c.id} “${c.name}”`);
      const list = ((steps as { sequence_steps?: MasterStep[] } | null)?.sequence_steps ?? []).slice().sort((a, b) => a.order - b.order);
      const key = slotKey(slot);
      out.set(key, [...(out.get(key) ?? []), { id: c.id, name: c.name, status: c.status, slot, steps: list, schedule }]);
    }
    return out;
  };
  // A run always reads now; a preview may reuse a read from the last few minutes.
  return fresh ? read() : withCache(`onboarding:masters:${instance}:${tag}`, 5 * 60_000, read);
}

const DAYS: [string, string][] = [["monday", "Mon"], ["tuesday", "Tue"], ["wednesday", "Wed"], ["thursday", "Thu"], ["friday", "Fri"], ["saturday", "Sat"], ["sunday", "Sun"]];
function scheduleText(s: Record<string, unknown> | null, timezone: string): string {
  if (!s) return "no schedule on the master";
  const on = DAYS.filter(([k]) => s[k]).map(([, d]) => d);
  const days = on.join("") === "MonTueWedThuFri" ? "Mon–Fri" : on.join(" ");
  const hm = (v: unknown) => String(v ?? "").slice(0, 5);
  const from = String(s.timezone ?? "");
  // The new timezone is stated once above the table; here only where the master differs.
  return `${days} ${hm(s.start_time)}–${hm(s.end_time)}${from && from !== timezone ? ` (master is on ${from})` : ""}`;
}

/** One campaign the step would make: where, under what name, copied from what. */
interface PlannedCampaign { instance: BisonInstanceKey; label: string; slot: CampaignSlot; name: string; master: MasterCampaign; existingIds: number[] }
interface CampaignPlan {
  tag: string; group: 1 | 2 | null; master: { tag: string; place: Place } | undefined;
  target: Place; timezone: string;
  inputs: AutomationInput[]; blockers: string[]; rows: string[][]; notes: PreviewNote[];
  /** Slots that can be created (one clear master each). All 12 are here when nothing blocks. */
  items: PlannedCampaign[];
}

/**
 * Everything the preview shows and the run acts on — built the same way for
 * both. `fresh` (the run) reads Email Bison now instead of reusing a recent
 * read: acting on a stale list of what already exists would create duplicates.
 */
async function planCampaigns(ctx: AutomationContext, fresh = false): Promise<CampaignPlan> {
  const search = (instance: BisonInstanceKey, q: string) =>
    fresh ? listCampaigns(instance, { search: q, strict: true })
      : withCache(`onboarding:existing:${instance}:${q}:v${nsVersion("onboarding")}`, 30_000, () => listCampaigns(instance, { search: q, strict: true }));
  const c = ctx.client;
  const tag = c.client_tag.toUpperCase();
  const blockers: string[] = [];
  const param = (k: string) => (typeof ctx.params[k] === "string" ? (ctx.params[k] as string).trim() : undefined);

  // The sheet only pre-fills — whatever is typed in the dialog wins.
  let sheet: NewClientInfoRow | undefined;
  try {
    sheet = [...(await withCache("onboarding:new-client-info", 60_000, fetchNewClientInfo))].reverse().find((r) => r.tags.includes(tag));
  } catch { /* no pre-fill */ }
  const guess = parsePlace(sheet?.office) ?? parsePlace(sheet?.area);
  const city = param("city") ?? guess?.city ?? "";
  // Whatever is typed wins; a field left alone follows the other one, then the sheet —
  // so changing the state to Texas doesn't keep the sheet's "CA".
  const typedState = param("state"), typedAbbr = param("abbr");
  let state = typedState ?? (typedAbbr ? regionByAny(typedAbbr)?.name : undefined) ?? guess?.state ?? "";
  let abbr = (typedAbbr ?? (typedState ? regionByAny(typedState)?.abbr : undefined) ?? guess?.abbr ?? "").toUpperCase();
  if (!state && abbr) state = regionByAny(abbr)?.name ?? "";
  if (!abbr && state) abbr = regionByAny(state)?.abbr ?? "";
  const area = param("area") ?? "";
  const target: Place = { area: area || defaultArea(city), city, state, abbr };
  const timezone = param("timezone") ?? timezoneForState(state) ?? timezoneForState(abbr) ?? "";
  const clientType = param("client_type") ?? (sheet?.clientType && !/clean|janitor/i.test(sheet.clientType) ? "other" : "cleaning");

  const fromSheet = sheet?.office ? `The sheet's office location: ${sheet.office}` : sheet ? "The sheet has no office location for this client." : `${tag} isn't in the sheet's New Client Information tab.`;
  const inputs: AutomationInput[] = [
    { key: "city", label: "City", type: "text", value: city, placeholder: "Anaheim", hint: guess && !guess.sure && param("city") === undefined ? `Guessed from the sheet — check it. ${fromSheet}` : fromSheet },
    { key: "state", label: "State", type: "text", value: state, placeholder: "California" },
    { key: "abbr", label: "State abbreviation", type: "text", value: abbr, placeholder: "CA" },
    { key: "area", label: "Area name", type: "text", value: area, placeholder: defaultArea(city) || "Orange County",
      hint: `How the area is named in the emails. Left empty it is “${defaultArea(city) || "<City> Area"}”.${sheet?.area ? ` The sheet's area: ${sheet.area}` : ""}` },
    { key: "timezone", label: "Timezone the campaigns send in", type: "select", value: timezone, options: TIMEZONE_OPTIONS.map((z) => ({ value: z, label: z.replace(/^.*\//, "").replace(/_/g, " ") + ` (${z})` })) },
    { key: "client_type", label: "Client type", type: "select", value: clientType,
      options: [{ value: "cleaning", label: "Cleaning client" }, { value: "other", label: "Other services (not covered yet)" }],
      hint: sheet?.clientType ? `The sheet says: ${sheet.clientType}` : undefined },
  ];

  const group = c.group_num;
  const master = group ? parseMasterSettings(await getSetting(CAMPAIGN_MASTERS_SETTING))[String(group) as "1" | "2"] : undefined;
  if (!group) blockers.push("This client has no group yet — run step 1, or set the group on the client's page.");
  else if (!master) blockers.push(`No master client is set for Group ${group} — an admin sets it under Onboarding → Team.`);
  if (clientType !== "cleaning") blockers.push("Only cleaning clients are covered — other clients' copy is written differently, so create these campaigns by hand.");
  const placeIssues = [...placeProblems(target, "This client"), ...(master ? placeProblems(master.place, `Master ${master.tag}`) : [])];
  blockers.push(...placeIssues);
  const known = regionByAny(state);
  if (known && state && known.name.toLowerCase() !== state.toLowerCase()) blockers.push(`State: write the full name — “${known.name}”, not “${state}”.`);
  else if (known && abbr && known.abbr !== abbr) blockers.push(`The state and its abbreviation don't match — ${known.name} is ${known.abbr}, not ${abbr}.`);
  if (!timezone) blockers.push("Choose the timezone the campaigns send in.");
  else if (!TIMEZONE_OPTIONS.includes(timezone)) blockers.push(`“${timezone}” isn't one of the timezones on the list.`);

  const rows: string[][] = [];
  const notes: PreviewNote[] = [];
  const items: PlannedCampaign[] = [];
  const copyIssues = new Set<string>();
  if (group && master) {
    for (const kind of ["b2b", "b2c"] as const) {
      const instance = GROUP_INSTANCES[group][kind];
      const label = `${kind === "b2b" ? "B2B" : "B2C"} #${group} ${GROUP_META[group][kind]}`;
      let masters: Map<string, MasterCampaign[]>;
      let mine: { id: number; name: string; status: string }[];
      let fromMaster: { id: number; name: string; status: string }[];
      try {
        [masters, mine, fromMaster] = await Promise.all([
          loadMasterCampaigns(instance, master.tag, fresh), search(instance, tag), search(instance, master.tag),
        ]);
      } catch (e) {
        blockers.push(`Couldn't read ${label} in Email Bison: ${(e as Error).message}`);
        continue;
      }
      // A copy that was made but never finished (an interrupted run) must be dealt with by a person first.
      const strays = [...mine, ...fromMaster].filter((x) => !gone(x.status) && (
        x.name.startsWith(`${CHECK_PREFIX}${tag}:`) || (x.name.startsWith("Copy of ") && x.name.includes(`${master.tag}:`))));
      for (const x of new Map(strays.map((y) => [y.id, y])).values()) {
        blockers.push(`${label}: an unfinished copy is still there — #${x.id} “${x.name}”. Look at it and delete it in Email Bison, then try again.`);
      }
      const copies: string[] = [];
      let shown = false;
      for (const slot of CAMPAIGN_SLOTS) {
        const name = campaignName(tag, slot);
        const already = mine.filter((x) => x.name.trim().toLowerCase() === name.toLowerCase() && !gone(x.status));
        const candidates = masters.get(slotKey(slot)) ?? [];
        if (candidates.length !== 1) {
          blockers.push(candidates.length
            ? `${label}: ${candidates.length} campaigns are named “${campaignName(master.tag, slot)}” (${candidates.map((m) => `#${m.id} ${m.status}`).join(", ")}) — only one can be the master.`
            : `${label}: the master ${master.tag} has no “${campaignName(master.tag, slot)}” campaign.`);
          rows.push([label, name, "—", "", "", ""]);
          continue;
        }
        const m = candidates[0];
        if (!m.steps.length) copyIssues.add(`${label}: couldn't read the emails of #${m.id} “${m.name}”.`);
        if (!m.schedule) copyIssues.add(`${label}: the master #${m.id} “${m.name}” has no schedule.`);
        copies.push(JSON.stringify(m.steps.map((s) => [s.email_subject, s.email_body, s.wait_in_days, s.thread_reply])));
        if (!placeIssues.length && m.steps.length) {
          const loc = localizeSteps(m.steps, master.place, target);
          for (const p of loc.problems) copyIssues.add(`${label} · ${slotKey(slot)}: ${p}`);
          if (!shown && !loc.problems.length) {
            shown = true;
            const seen = new Map<string, number[]>();
            for (const ch of loc.changes) { const k = `    was: ${ch.before}\n    now: ${ch.after}`; seen.set(k, [...(seen.get(k) ?? []), ch.order]); }
            notes.push({
              title: `Lines that change in the ${kind === "b2b" ? "B2B" : "B2C"} emails (everything else is copied as it is)`,
              text: [...seen.entries()].map(([k, orders]) => `Email${orders.length > 1 ? "s" : ""} ${[...new Set(orders)].join(", ")}\n${k}`).join("\n\n"),
            });
          }
        }
        items.push({ instance, label, slot, name, master: m, existingIds: already.map((x) => x.id) });
        rows.push([
          label,
          already.length ? `${name} — already exists (${already.map((x) => `#${x.id}`).join(", ")}), left as it is` : name,
          `#${m.id} ${m.status}`,
          String(m.steps.length),
          m.steps.slice(0, -1).map((s) => s.wait_in_days).join(" → "),
          scheduleText(m.schedule, timezone),
        ]);
      }
      if (new Set(copies).size > 1) notes.push({ title: `${label}: the master's six campaigns don't all carry the same emails`, text: "Each new campaign copies the master campaign in its own slot, so those differences carry over." });
    }
  }
  blockers.push(...copyIssues);
  return { tag, group, master, target, timezone, inputs, blockers, rows, notes, items };
}

const createCampaigns: Automation = {
  async preview(ctx) {
    const p = await planCampaigns(ctx);
    const exists = p.items.filter((i) => i.existingIds.length).length;
    if (!campaignCreationEnabled()) p.blockers.push(NOT_SWITCHED_ON);
    return {
      title: "Create email campaigns",
      lines: [
        p.master && p.group
          ? `Copies ${p.master.tag}'s 6 campaigns in each of Group ${p.group}'s two instances — 12 new campaigns for ${p.tag}, created as drafts. Nothing is launched.`
          : "Copies the master client's 6 campaigns in each of the group's two instances — 12 new campaigns, created as drafts.",
        `Renames them for ${p.tag} and swaps the master's place names for ${p.target.city || "this client's city"}${p.target.state ? `, ${p.target.state}` : ""} in the email bodies. Subjects and variables ({CITY}, {QUESTION}, …) are not touched.`,
        `Sets every schedule to ${p.timezone || "the chosen timezone"}; days and hours stay as on the master.`,
        "Reads every campaign back after writing it. One that doesn't match is not left under the client's name, and the run stops there.",
        ...(exists ? [`${exists} of the 12 already exist and are left as they are.`] : []),
        "Marks this step Done once all 12 are there.",
      ],
      inputs: p.inputs,
      blockers: p.blockers,
      tables: p.rows.length ? [{ title: "The 12 campaigns", columns: ["Instance", "New campaign", "Copied from", "Emails", "Days between", "Schedule"], rows: p.rows }] : [],
      notes: p.notes,
    };
  },

  async run(ctx) {
    if (!campaignCreationEnabled()) return { ok: false, summary: NOT_SWITCHED_ON };
    // Rebuilt now, on fresh reads — never trusted from the preview.
    const p = await planCampaigns(ctx, true);
    if (p.blockers.length) return { ok: false, summary: p.blockers.join(" ") };
    if (!p.master || p.items.length !== 2 * CAMPAIGN_SLOTS.length) return { ok: false, summary: "The plan isn't complete — open the preview to see why." };

    const tags: TagCache = new Map();
    const results: { instance: string; name: string; state: "created" | "exists" | "failed"; campaignId: number | null; note?: string }[] = [];
    for (const item of p.items) {
      if (item.existingIds.length) { results.push({ instance: item.instance, name: item.name, state: "exists", campaignId: item.existingIds[0] }); continue; }
      const r = await createCampaignFromMaster({
        instance: item.instance, name: item.name, nurture: item.slot.nurture, clientTag: p.tag,
        master: { id: item.master.id, name: item.master.name, steps: item.master.steps },
        masterPlace: p.master.place, target: p.target, timezone: p.timezone,
      }, tags);
      results.push(r);
      // Something unexpected from Email Bison: stop rather than make more copies the same way.
      if (r.state === "failed") break;
    }
    const created = results.filter((r) => r.state === "created").length;
    const existed = results.filter((r) => r.state === "exists").length;
    const bad = results.find((r) => r.state === "failed");
    if (bad) {
      const left = p.items.length - results.length;
      return {
        ok: false,
        summary: `Stopped at “${bad.name}” (${bad.instance}): ${bad.note} ${created} created before it${left ? `, ${left} not attempted` : ""}. Fix that, then run again — the ones already made are kept.`,
        result: { results },
      };
    }
    return {
      ok: true,
      summary: `${created} campaign${created === 1 ? "" : "s"} created for ${p.tag}${existed ? `, ${existed} already there` : ""} — all drafts, copied from ${p.master.tag}.`,
      result: { results },
    };
  },
};

// ── 3. Attach client tags / redirects / add to campaigns / 3 per day ────────
// LeadSync owns the domain reserve, so it decides which domains a new client
// gets and does the work (lib/leadsync.ts): tag → redirect → attach to the
// client's campaigns → client sheet → whitelist queue → 3 a day.
// One request allocates ONE batch (5 domains, ~245 inboxes) — the dialog keeps
// sending batches until LeadSync's plan has nothing left to add.
// Running is OFF unless ONBOARDING_ALLOCATE_DOMAINS=1 is set here (LeadSync
// has its own switch too). Until then this is a preview.

/** Server-side switch for actually allocating domains (the preview always works). */
export const domainAllocationEnabled = () => process.env.ONBOARDING_ALLOCATE_DOMAINS === "1";
const ALLOCATION_NOT_SWITCHED_ON =
  "Allocating domains isn't switched on yet — this shows what LeadSync would give the client. Do the step by hand for now.";
const ALLOCATION_BATCH = 5;
const DAILY_LIMIT = 3;

/** "Tier 1 (Base)" → "1". Anything else is left to LeadSync (it reads the Client Tracker). */
function tierOfPlan(plan: string | null): "0.5" | "1" | "2" | undefined {
  const p = plan ?? "";
  return /tier\s*0\.5/i.test(p) ? "0.5" : /tier\s*2/i.test(p) ? "2" : /tier\s*1/i.test(p) ? "1" : undefined;
}

/** "jan-pro.com/socal" → "https://jan-pro.com/socal"; "" when it isn't a usable address. */
function asHttpsUrl(raw: string): string {
  const t = raw.trim().replace(/^http:\/\//i, "https://");
  if (!t) return "";
  try {
    const u = new URL(/^https:\/\//i.test(t) ? t : `https://${t}`);
    return u.hostname.includes(".") ? u.toString() : "";
  } catch { return ""; }
}

interface AllocationSidePlan extends AllocationSide { campaignIds: number[] }
interface AllocationPlanView {
  tag: string; tier: "0.5" | "1" | "2" | undefined; redirect: string;
  /** LeadSync's plan as received (null when it couldn't be had). */
  plan: AllocationPlan | null;
  inputs: AutomationInput[]; blockers: string[]; rows: string[][]; notes: PreviewNote[];
  summary: string; sides: AllocationSidePlan[];
}

/** What the preview shows and one batch acts on. `fresh` (the run) asks LeadSync and Email Bison again. */
async function planAllocation(ctx: AutomationContext, fresh = false): Promise<AllocationPlanView> {
  const c = ctx.client;
  const tag = c.client_tag.toUpperCase();
  const blockers: string[] = [];
  const tier = typeof ctx.params.tier === "string" && ["0.5", "1", "2"].includes(ctx.params.tier) ? (ctx.params.tier as "0.5" | "1" | "2") : tierOfPlan(c.plan_type);

  // Redirect = the client's website on the onboarding form; what is typed here wins.
  let fromSheet = "";
  try { fromSheet = (await withCache("onboarding:websites", 60_000, fetchOnboardingWebsites)).get(tag) ?? ""; } catch { /* no pre-fill */ }
  const typed = typeof ctx.params.redirect === "string" ? ctx.params.redirect.trim() : undefined;
  const redirectRaw = typed ?? fromSheet;
  const redirect = asHttpsUrl(redirectRaw);
  const inputs: AutomationInput[] = [
    { key: "tier", label: "Tier", type: "select", value: tier ?? "",
      options: [{ value: "0.5", label: "Tier 0.5 — 20 B2B + 5 B2C domains" }, { value: "1", label: "Tier 1 — 20 B2B + 5 B2C domains" }, { value: "2", label: "Tier 2 — 40 B2B + 10 B2C domains" }],
      hint: c.plan_type ? `The client's plan here: ${c.plan_type}` : "No plan on the client — left empty, LeadSync uses the Client Tracker's tier." },
    { key: "redirect", label: "Redirect the domains to", type: "text", value: redirectRaw, placeholder: "https://client-website.com",
      hint: fromSheet ? `The onboarding form's Company Website: ${fromSheet}` : `${tag} has no Company Website on the onboarding form — type the address.` },
  ];
  if (!redirect) blockers.push(redirectRaw ? `“${redirectRaw}” isn't a web address the domains can redirect to.` : "There is no website to redirect the domains to.");

  const rows: string[][] = [];
  const notes: PreviewNote[] = [];
  const sides: AllocationSidePlan[] = [];
  let plan: AllocationPlan | null = null;
  let summary = "Asks LeadSync which reserve domains this client would get.";
  if (!c.group_num) {
    blockers.push("This client has no group yet — run step 1, or set the group on the client's page.");
  } else {
    const r = await previewOnboardingAllocation(tag, c.group_num, tier, fresh);
    if (!r.ok) {
      blockers.push(`Couldn't get the plan from LeadSync: ${r.error}`);
    } else {
      const p = r.plan;
      plan = p;
      if (p.groupMismatch) blockers.push(`LeadSync's allocation sheet has ${tag} in Group ${p.allocationGroup}, not Group ${c.group_num} — sort out which is right before allocating.`);
      summary = `LeadSync's plan for ${tag} at Tier ${p.tier} (tier from ${p.tierSource === "request" ? "the choice above" : `the ${p.tierSource}`}), as of ${fmtDate(p.generatedFor)}.`;
      for (const s of p.instances) {
        // The client's own campaigns here — the ones step 2 made — are what the domains attach to.
        let campaignIds: number[] = [];
        try {
          const found = (await (fresh
            ? listCampaigns(s.instance, { search: tag, strict: true })
            : withCache(`onboarding:existing:${s.instance}:${tag}:v${nsVersion("onboarding")}`, 30_000, () => listCampaigns(s.instance, { search: tag, strict: true }))))
            .filter((x) => !gone(x.status));
          const missing: string[] = [];
          for (const slot of CAMPAIGN_SLOTS) {
            const name = campaignName(tag, slot);
            const hits = found.filter((x) => x.name.trim().toLowerCase() === name.toLowerCase());
            if (hits.length === 1) campaignIds.push(hits[0].id);
            else if (hits.length > 1) blockers.push(`${s.label}: ${hits.length} campaigns are named “${name}” — there should be one.`);
            else missing.push(slotKey(slot));
          }
          if (missing.length) { blockers.push(`${s.label}: ${tag} has no ${missing.join(", ")} campaign${missing.length === 1 ? "" : "s"} yet — step 2 creates them.`); campaignIds = []; }
        } catch (e) {
          blockers.push(`Couldn't read ${tag}'s campaigns on ${s.label}: ${(e as Error).message}`);
        }
        sides.push({ ...s, campaignIds });
        rows.push([s.label, String(s.cap), String(s.alreadyTagged), String(s.need), String(s.reserveAvailable), s.short ? String(s.short) : "—", campaignIds.length ? `${campaignIds.length} campaigns` : "—"]);
        if (s.short > 0) blockers.push(`${s.label}: ${s.short} domain${s.short === 1 ? "" : "s"} short — ${s.need} needed, ${s.reserveAvailable} ready in the reserve.`);
        if (s.note) blockers.push(`${s.label}: LeadSync says “${s.note}”.`);
        if (s.setAside) notes.push({ title: `${s.label} — ${s.setAside} reserve domain${s.setAside === 1 ? " was" : "s were"} left out`, text: "They already carry a client's tag, so they are not offered." });
        if (s.picking.length) notes.push({ title: `${s.label} — the ${s.picking.length} domain${s.picking.length === 1 ? "" : "s"} it would give`, text: s.picking.join("\n") });
      }
    }
  }
  return { tag, tier, redirect, plan, inputs, blockers, rows, notes, summary, sides };
}

const allocateDomains: Automation = {
  async preview(ctx) {
    const p = await planAllocation(ctx);
    if (!domainAllocationEnabled()) p.blockers.push(ALLOCATION_NOT_SWITCHED_ON);
    const left = p.sides.reduce((n, s) => n + s.need, 0);
    return {
      title: "Attach client tags / redirects / add to campaigns / set 3 per day",
      lines: [
        p.summary,
        "LeadSync only gives domains that no client it knows is using, that are at least 21 days old, not marked Burnt and not blacklisted — the same rules as its own top-ups — and leaves out any that already carry a Client Tracker tag.",
        `Running it has LeadSync tag those domains for ${p.tag}, point their redirect at ${p.redirect || "the client's website"}, attach them to ${p.tag}'s campaigns, add them to the client's sheet, queue the whitelist email (6:30 AM PT) and set every sender to ${DAILY_LIMIT} a day.`,
        `It works in batches of ${ALLOCATION_BATCH} domains${left ? ` — ${Math.ceil(left / ALLOCATION_BATCH)} to go here` : ""} — and marks this step Done when nothing is left to add.`,
      ],
      inputs: p.inputs,
      blockers: p.blockers,
      tables: p.rows.length ? [{ title: "Domains by instance", columns: ["Instance", "Tier gets", "Already tagged", "To add", "Ready in reserve", "Short", "Attaches to"], rows: p.rows }] : [],
      notes: p.notes,
    };
  },

  /** ONE batch. `more` tells the caller to run again; the step is Done when nothing is left. */
  async run(ctx) {
    if (!domainAllocationEnabled()) return { ok: false, summary: ALLOCATION_NOT_SWITCHED_ON };
    // The plan may be the one kept from a few minutes ago (each new plan is a
    // heavy read for LeadSync). That is safe: LeadSync rebuilds its own plan
    // for every batch and refuses anything that no longer holds.
    const p = await planAllocation(ctx);
    const group = ctx.client.group_num;
    if (p.blockers.length) return { ok: false, summary: p.blockers.join(" ") };
    if (!group || !p.plan || !p.sides.length) return { ok: false, summary: "LeadSync returned no plan — open the preview to see why." };
    const total = (s: AllocationSidePlan) => `${s.label} ${s.cap}`;
    const side = p.sides.find((s) => s.need > 0);
    if (!side) return { ok: true, summary: `All of ${p.tag}'s domains are allocated — ${p.sides.map(total).join(", ")}.` };

    const domains = side.picking.slice(0, ALLOCATION_BATCH);
    const r = await runOnboardingAllocation({
      clientTag: p.tag, group, tier: p.tier, instance: side.instance,
      domains, redirectUrl: p.redirect, campaignIds: side.campaignIds, dailyLimit: DAILY_LIMIT,
    });
    // Whatever went wrong, the kept plan is no longer trusted — the next try asks again.
    if (!r.ok || !r.result.ok) rememberAllocationPlan(p.tag, group, p.tier, null);
    if (!r.ok) return { ok: false, summary: `LeadSync didn't take the batch for ${side.label}: ${r.error}`, result: { instance: side.instance, domains } };
    const res = r.result;
    if (!res.ok) {
      const bad = res.steps.filter((x) => x.state === "failed" || x.state === "degraded").map((x) => `${x.label}${x.note ? ` (${x.note})` : ""}`);
      const limit = res.limit.error ? `daily limit: ${res.limit.error}` : res.limit.failed ? `daily limit not set on ${res.limit.failed} sender(s)` : "";
      return {
        ok: false,
        summary: `${side.label}: ${domains.length} domains were handed to LeadSync but not everything went through — ${[...bad, limit].filter(Boolean).join("; ") || "see LeadSync"}. Look at LeadSync's Replacement page before running again.`,
        result: { instance: side.instance, domains, leadsync: res },
      };
    }
    const done = side.alreadyTagged + domains.length;
    const more = p.sides.some((s) => (s === side ? s.need - domains.length : s.need) > 0);
    // The plan, as it stands now: these domains are the client's, the rest are still to come.
    rememberAllocationPlan(p.tag, group, p.tier, {
      ...p.plan,
      instances: p.plan.instances.map((s) => s.instance !== side.instance ? s : {
        ...s, alreadyTagged: done, need: s.need - domains.length, reserveAvailable: s.reserveAvailable - domains.length,
        picking: s.picking.filter((d) => !domains.includes(d)),
      }),
    });
    return {
      ok: true, more,
      summary: more
        ? `${side.label}: ${domains.length} more domains added — ${done} of ${side.cap}.`
        : `All of ${p.tag}'s domains are allocated — ${p.sides.map(total).join(", ")}.`,
      result: { instance: side.instance, domains, leadsync: res },
    };
  },
};

/** Whether a task's automation may be RUN on this server right now (previews are separate). */
export function automationRunnable(key: string | null | undefined): boolean {
  if (!key) return false;
  if (key === "create_campaigns") return campaignCreationEnabled();
  if (key === "allocate_domains") return domainAllocationEnabled();
  return !!AUTOMATION_META[key]?.built;
}

const AUTOMATIONS: Record<string, Automation> = {
  slack_outreachify: slackOutreachify,
  create_campaigns: createCampaigns,
  allocate_domains: allocateDomains,
};

export function getAutomation(key: string | null | undefined): Automation | null {
  return (key && AUTOMATIONS[key]) || null;
}
