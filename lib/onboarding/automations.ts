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
  getSetting, setClientGroup, setClientTimezone, listOnboardingUsers, lastFailedAttempt, runResults, takeLock, releaseLock, lockHolder, listTasks,
  type OnboardingClientRow, type OnboardingTaskRow,
} from "@/lib/onboarding/store";
import { GROUP_META, AUTOMATION_META, groupText, fmtDate, fmtStamp } from "@/lib/onboarding/ui";
import { groupForStartDate } from "@/lib/onboarding/generate";
import { withCache, nsVersion } from "@/lib/server-cache";
import { fetchNewClientInfo, fetchOnboardingWebsites, fetchOnboardingFormDetails, type NewClientInfoRow, type OnboardingFormDetails } from "@/lib/google-sheets";
import db from "@/lib/db";
import supabase from "@/lib/supabase";
import { bumpVersion } from "@/lib/server-cache";
import { syncAll } from "@/lib/sync/sheets-to-supabase";
import { parseFormPeople, buildReplyTemplate, isEmail, nearMiss } from "@/lib/onboarding/rr-setup";
import { listCampaigns, lookUpCampaign, listTags, createTag } from "@/lib/outboundhero-api";
import {
  previewOnboardingAllocation, runOnboardingAllocation, rememberAllocationPlan, forgetAllocationPlans, previewOnboardingWhitelist, runOnboardingWhitelist,
  leadsyncRunSecretSet, type AllocationSide, type AllocationPlan, type WhitelistPlan,
} from "@/lib/leadsync";
import type { BisonInstanceKey } from "@/lib/bison-instances-shared";
import { clientContacts } from "@/lib/onboarding/contacts";
import { defaultArea } from "@/lib/onboarding/campaign-copy";
import {
  buildCampaign, campaignLimits, campaignSchedule, serviceAreaLine, addressSpintax, tierOf, tierSupported, unsafeForSpintax,
  BUILD_PREFIX, CHECK_PREFIX, type CampaignScheduleBody, type InstanceKind,
} from "@/lib/onboarding/build-campaigns";
import { realBisonOps } from "@/lib/onboarding/bison-ops";
import { copyForClient } from "@/lib/onboarding/copy-store";
import { CLIENT_TYPES, checkSequence, clientTypeLabel, isClientType, sendDays, toBisonSteps, type BisonStepPayload, type ClientTypeKey } from "@/lib/onboarding/copy-model";
import {
  CAMPAIGN_SLOTS, GROUP_INSTANCES, CAMPAIGN_TIMEZONES, isCampaignTimezone, timezoneLabel, suggestTimezone, campaignName, slotKey,
  parsePlace, regionByAny, type CampaignSlot,
} from "@/lib/onboarding/campaign-plan";

export interface AutomationInput {
  key: string; label: string; type: "group" | "text" | "select" | "textarea" | "hidden";
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
  /** "run" when the preview is the check right before running — it then reads fresh, not from a recent answer. */
  mode?: "preview" | "run";
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
// The client's 12 campaigns are built from scratch, the way Clay's workbook
// built them, from the email copy library (lib/onboarding/build-campaigns.ts):
// 6 in its group's B2B instance and 6 in its B2C instance, as drafts. Nothing
// is launched; no senders or leads are added (step 3 adds the senders).
// Creating is OFF unless ONBOARDING_CREATE_CAMPAIGNS=1 is set on the server.

/** Server-side switch for actually creating campaigns (the preview always works). */
export const campaignCreationEnabled = () => process.env.ONBOARDING_CREATE_CAMPAIGNS === "1";
const NOT_SWITCHED_ON =
  "Creating the campaigns isn't switched on on this server (ONBOARDING_CREATE_CAMPAIGNS). This is a preview; complete the step by hand for now.";

const gone = (status: string) => /archiv|delet/i.test(status);

/** The client type from the sheet's "Client Type" answer (blank → Cleaning, the usual case). */
function clientTypeFromSheet(text: string | null | undefined): ClientTypeKey {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return "cleaning";
  if (/non[\s-]*clean/.test(t)) return "non_cleaning";
  if (/\bos\b|other services/.test(t)) return "os";
  if (/internal/.test(t)) return "internal";
  if (/clean|janitor/.test(t)) return "cleaning";
  return "non_cleaning";
}

/** One campaign the step would make. */
interface PlannedCampaign {
  instance: BisonInstanceKey; kind: InstanceKind; label: string; slot: CampaignSlot; name: string;
  existingIds: number[];
  limits: { max_emails_per_day: number; max_new_leads_per_day: number };
  schedule: CampaignScheduleBody;
  modeTag: { id: number; name: string } | null;
}
interface CampaignPlan {
  tag: string; group: 1 | 2 | null; timezone: string; clientType: ClientTypeKey;
  inputs: AutomationInput[]; blockers: string[]; rows: string[][]; notes: PreviewNote[]; lines: string[];
  /** All 12 when nothing blocks. */
  items: PlannedCampaign[];
  steps: BisonStepPayload[];
  /** The client's own tag in each instance (null = it gets created when the first campaign there is made). */
  clientTagId: Partial<Record<BisonInstanceKey, number | null>>;
  /** The client details this plan writes into the copy — saved with each campaign made, so a retry uses the same. */
  pinned: Record<string, string>;
}

/** The inputs that change what the 12 campaigns say or how they're set up — all 12 must share them. */
const PINNED_KEYS = ["client_type", "tier", "timezone", "city", "state", "abbr", "area", "office_address", "company_name", "service_area", "office_line"] as const;
const PINNED_LABEL: Record<string, string> = {
  client_type: "client type", tier: "tier", timezone: "time zone", city: "city", state: "state", abbr: "abbreviation", area: "area name",
  office_address: "office address", company_name: "company name", service_area: "service-area line", office_line: "office line",
};

/**
 * Everything the preview shows and the run acts on — built the same way for
 * both. `fresh` (the run) asks Email Bison now instead of using a recent answer:
 * acting on a stale list could create duplicates.
 */
async function planCampaigns(ctx: AutomationContext, fresh = false): Promise<CampaignPlan> {
  const search = (instance: BisonInstanceKey, q: string) =>
    fresh ? listCampaigns(instance, { search: q, strict: true })
      : withCache(`onboarding:existing:${instance}:${q}:v${nsVersion("onboarding")}`, 30_000, () => listCampaigns(instance, { search: q, strict: true }));
  const tagsOf = (instance: BisonInstanceKey) =>
    fresh ? listTags(instance) : withCache(`onboarding:tags:${instance}:v${nsVersion("onboarding")}`, 60_000, () => listTags(instance));
  const c = ctx.client;
  const tag = c.client_tag.toUpperCase();
  const blockers: string[] = [];
  const notes: PreviewNote[] = [];
  // Campaigns this step already made carry the client details they were made with. A retry starts
  // from those (and is held to them below), so all 12 say the same thing.
  let madeWith: Record<string, string> | null = null, madeCount = 0;
  for (const res of await runResults(ctx.task.id)) {
    for (const x of (Array.isArray(res.results) ? res.results : []) as { state?: unknown; lines?: unknown }[]) {
      if (x.state !== "created") continue;
      madeCount++;
      if (x.lines && typeof x.lines === "object") madeWith = x.lines as Record<string, string>; // oldest wins (results are newest first)
    }
  }
  const given = (k: string) => (typeof ctx.params[k] === "string" ? (ctx.params[k] as string) : typeof madeWith?.[k] === "string" ? madeWith[k] : undefined);
  const param = (k: string) => given(k)?.trim();
  const rawParam = (k: string) => given(k);

  // What the sheets say (they only pre-fill — whatever is typed here wins).
  let sheet: NewClientInfoRow | undefined;
  let unread = false;
  try { sheet = [...(await withCache("onboarding:new-client-info", 60_000, fetchNewClientInfo))].reverse().find((r) => r.tags.includes(tag)); } catch { unread = true; }
  let form: OnboardingFormDetails | undefined;
  try { form = (await withCache("onboarding:form-details", 60_000, fetchOnboardingFormDetails)).get(tag); } catch { unread = true; }
  // Right before a run nothing may quietly fall back to a default because a sheet didn't answer.
  if (fresh && unread) blockers.push("Couldn't read the onboarding sheet just now — try again in a moment.");

  // Client type.
  const typeParam = param("client_type");
  const clientType: ClientTypeKey = isClientType(typeParam) ? typeParam : clientTypeFromSheet(form?.clientType || sheet?.clientType);
  const typeSaid = form?.clientType || sheet?.clientType || "";
  if (clientType === "os") blockers.push("OS clients' campaigns are set up by hand — that's the rule for OS clients.");

  // Place (city / state / abbreviation / area).
  const guess = parsePlace(sheet?.office) ?? parsePlace(form?.address) ?? parsePlace(sheet?.area);
  const city = param("city") ?? guess?.city ?? "";
  const typedState = param("state"), typedAbbr = param("abbr");
  let state = typedState ?? (typedAbbr ? regionByAny(typedAbbr)?.name : undefined) ?? guess?.state ?? "";
  let abbr = (typedAbbr ?? (typedState ? regionByAny(typedState)?.abbr : undefined) ?? guess?.abbr ?? "").toUpperCase();
  if (!state && abbr) state = regionByAny(abbr)?.name ?? "";
  if (!abbr && state) abbr = regionByAny(state)?.abbr ?? "";
  const area = param("area") ?? "";
  const place = { area: area || defaultArea(city), city, state, abbr };
  const region = regionByAny(state) ?? regionByAny(abbr);

  // Time zone and tier.
  const timezone = param("timezone") ?? c.campaign_timezone ?? suggestTimezone(state) ?? suggestTimezone(abbr) ?? "";
  const tier = param("tier") ?? tierOf(c.plan_type) ?? tierOf(sheet?.plan) ?? "";

  // The client lines and name that fill the copy's [[fields]].
  const officeAddress = param("office_address") ?? (form?.address || sheet?.office || "");
  const serviceArea = rawParam("service_area") ?? (city && state ? serviceAreaLine(clientType === "cleaning", place) : "");
  const officeLine = rawParam("office_line") ?? addressSpintax(officeAddress, region ? { abbr: region.abbr, name: region.name } : null);
  const companyName = param("company_name") ?? (form?.companyName || c.client_name || "");

  const fromSheet = sheet?.office ? `The sheet's office location: ${sheet.office}` : sheet ? "The sheet has no office location for this client." : `${tag} isn't in the sheet's New Client Information tab.`;
  const inputs: AutomationInput[] = [
    { key: "client_type", label: "Client type", type: "select", value: clientType,
      options: CLIENT_TYPES.map((t) => ({ value: t.key, label: t.label })),
      hint: typeSaid ? `The sheet says: ${typeSaid}` : "The sheet doesn't say — Cleaning is assumed. Check it." },
    { key: "tier", label: "Tier (sets the daily limits)", type: "select", value: tier,
      options: [{ value: "0.5", label: "Tier 0.5 (Trial)" }, { value: "1", label: "Tier 1 (Base)" }, { value: "2", label: "Tier 2 (Scale) — double" }],
      hint: c.plan_type ? `Plan: ${c.plan_type}` : sheet?.plan ? `The sheet's plan: ${sheet.plan}` : undefined },
    { key: "timezone", label: "Time zone the campaigns send in", type: "select", value: timezone, options: CAMPAIGN_TIMEZONES.map((z) => ({ value: z, label: timezoneLabel(z) })),
      hint: c.campaign_timezone ? `The client's time zone (set on its page): ${c.campaign_timezone}` : "Not set on the client's page yet — suggested from the office's state." },
    { key: "city", label: "City", type: "text", value: city, placeholder: "Anaheim", hint: guess && !guess.sure && param("city") === undefined ? `Guessed from the sheet — check it. ${fromSheet}` : fromSheet },
    { key: "state", label: "State", type: "text", value: state, placeholder: "California" },
    { key: "abbr", label: "State abbreviation", type: "text", value: abbr, placeholder: "CA" },
    { key: "area", label: "Area name", type: "text", value: area, placeholder: defaultArea(city) || "Orange County",
      hint: `How the area is named in the service-area line. Left empty it is “${defaultArea(city) || "<City> Area"}”.${sheet?.area ? ` The sheet's area: ${sheet.area}` : ""}` },
    { key: "office_address", label: "Office address", type: "text", value: officeAddress, placeholder: "811 E Chapman Ave, Orange, CA 92866",
      hint: form?.address ? "From the Onboarding Form." : undefined },
    { key: "company_name", label: "Company name", type: "text", value: companyName, hint: "Fills [[COMPANY_NAME]] wherever the copy uses it." },
    { key: "service_area", label: "Service-area line ([[SERVICE_AREA]])", type: "textarea", value: serviceArea,
      hint: rawParam("service_area") === undefined ? "Written from the area, city and state in Clay's pattern — edit it if needed." : undefined },
    { key: "office_line", label: "Office line ([[OFFICE_ADDRESS]])", type: "textarea", value: officeLine,
      hint: rawParam("office_line") === undefined ? "The office address with spintax, by Clay's rules — edit it if needed." : undefined },
  ];

  // Checks on the client's details.
  const group = c.group_num;
  if (!group) blockers.push("This client has no group yet — the first step (Tell Outreachify on Slack) picks it, or set it on the client's page.");
  if (!timezone) blockers.push("Choose the time zone the campaigns send in.");
  else if (!isCampaignTimezone(timezone)) blockers.push(`“${timezone}” isn't one of the campaign time zones.`);
  if (!tierSupported(tier)) blockers.push(tier ? `Tier ${tier} has no daily limits in Clay's rules (0.5, 1 or 2) — choose the tier to use.` : "Choose the tier (it sets the daily limits).");
  if (!city || !state || !abbr) blockers.push("Fill in the city, state and abbreviation.");
  const known = regionByAny(state);
  if (state && !known) blockers.push(`“${state}” isn't a state or province this knows — check the spelling.`);
  else if (known && state && known.name.toLowerCase() !== state.toLowerCase()) blockers.push(`State: write the full name — “${known.name}”, not “${state}”.`);
  else if (known && abbr && known.abbr !== abbr) blockers.push(`The state and its abbreviation don't match — ${known.name} is ${known.abbr}, not ${abbr}.`);
  if (abbr && !regionByAny(abbr)) blockers.push(`“${abbr}” isn't a state or province abbreviation.`);
  for (const [label, v] of [["The area name", area], ["The city", city], ["The state", state]] as const) {
    if (v && unsafeForSpintax(v)) blockers.push(`${label} can't contain { } | [ ] < or >.`);
  }

  // The emails: the client's own copy, else its type's shared copy, with the fields filled.
  let steps: BisonStepPayload[] = [];
  let copyLabel = "";
  const copy = clientType === "os" ? null : await copyForClient(tag, clientType);
  if (clientType !== "os" && !copy) blockers.push(`There's no shared ${clientTypeLabel(clientType)} copy yet — write it under Onboarding › Email copy.`);
  if (copy) {
    copyLabel = copy.source === "client" ? `${tag}'s own copy (version ${copy.version})` : `the shared ${clientTypeLabel(clientType)} copy (version ${copy.version})`;
    // The copy this preview showed travels with the approval: if it changes before or during the
    // run, the run stops rather than building some campaigns from one version and some from another.
    const pin = `${copy.source}:${copy.version}`;
    const pinned = param("copy_pin");
    if (pinned && pinned !== pin) blockers.push(`The email copy changed since this preview (now ${copyLabel}) — look at the preview again before running.`);
    inputs.push({ key: "copy_pin", label: "", type: "hidden", value: pin });
    const check = checkSequence(copy.sequence);
    if (check.errors.length) blockers.push(`The copy has problems — fix them under Email copy first: ${check.errors.slice(0, 3).map((e) => `email ${e.step}: ${e.message}`).join(" ")}`);
    const built = toBisonSteps(copy.sequence, { SERVICE_AREA: serviceArea, OFFICE_ADDRESS: officeLine, COMPANY_NAME: companyName });
    steps = built.steps;
    const label: Record<string, string> = { SERVICE_AREA: "service-area line", OFFICE_ADDRESS: "office line", COMPANY_NAME: "company name" };
    if (built.missing.length) blockers.push(`The copy uses the ${built.missing.map((m) => label[m] ?? m).join(" and ")}, which ${built.missing.length > 1 ? "are" : "is"} empty — fill ${built.missing.length > 1 ? "them" : "it"} in.`);
    for (const pr of built.problems) blockers.push(`${pr} (check the client lines above)`);
    const days = sendDays(copy.sequence);
    notes.push({
      title: `The emails, as they'll be written — ${copyLabel}`,
      text: steps.map((s, i) => [
        `── Email ${i + 1} · day ${days[i]} · ${i === 0 ? "starts the thread" : s.thread_reply ? "reply in the same thread" : "new thread"}`,
        `Subject: ${s.thread_reply ? "Re: " : ""}${s.email_subject}`,
        "",
        s.email_body,
      ].join("\n")).join("\n\n"),
    });
  }

  // An earlier try that stopped part-way: its campaign must be gone before another is made for that slot
  // (asked by id — Email Bison's search can lag), and an unanswered create gets time to show up.
  for (const res of await runResults(ctx.task.id, 20)) {
    for (const x of (Array.isArray(res.results) ? res.results : []) as { instance?: unknown; name?: unknown; state?: unknown; campaignId?: unknown; unsure?: unknown; at?: unknown }[]) {
      if (x.state !== "failed") continue;
      if (typeof x.campaignId === "number" && typeof x.instance === "string") {
        const c = await lookUpCampaign(x.instance, x.campaignId);
        if (c === null) blockers.push(`Couldn't check whether #${x.campaignId} (from an earlier try at “${x.name}”) is still in Email Bison — try again.`);
        else if (c !== "gone" && !gone(c.status)) blockers.push(`#${x.campaignId} “${c.name}” from an earlier try is still in Email Bison — look at it and delete it, then run again.`);
      } else if (x.unsure && typeof x.at === "string" && Date.now() - Date.parse(x.at) < 10 * 60_000) {
        const mins = Math.max(1, Math.ceil((10 * 60_000 - (Date.now() - Date.parse(x.at))) / 60_000));
        blockers.push(`The last try at “${x.name}” got no answer from Email Bison, so it may have been made as “${BUILD_PREFIX}${x.name}”. Check Email Bison for it — this step can run again in about ${mins} minute${mins === 1 ? "" : "s"}.`);
      }
    }
  }

  // The 12 campaigns, and what's in Email Bison already.
  const rows: string[][] = [];
  const items: PlannedCampaign[] = [];
  const clientTagId: Partial<Record<BisonInstanceKey, number | null>> = {};
  const toCreateTag: string[] = [];
  const suffix = clientTypeLabel(clientType);
  if (group) {
    for (const kind of ["b2b", "b2c"] as const) {
      const instance = GROUP_INSTANCES[group][kind];
      const label = `${kind === "b2b" ? "B2B" : "B2C"} #${group} ${GROUP_META[group][kind]}`;
      let mine: { id: number; name: string; status: string }[];
      let tags: { id: number; name: string }[];
      try {
        [mine, tags] = await Promise.all([search(instance, tag), tagsOf(instance)]);
      } catch (e) {
        blockers.push(`Couldn't read ${label} in Email Bison: ${(e as Error).message}`);
        continue;
      }
      const live = mine.filter((x) => !gone(x.status));
      const prefix = `${tag}:`.toLowerCase();
      for (const x of live) {
        const n = x.name.trim();
        if (n.toLowerCase().startsWith(`${CHECK_PREFIX}${tag}:`.toLowerCase()) || n.toLowerCase().startsWith(`${BUILD_PREFIX}${tag}:`.toLowerCase())) {
          blockers.push(`${label}: an unfinished campaign is still there — #${x.id} “${n}”. Look at it and delete it in Email Bison, then try again.`);
        } else if (n.toLowerCase().startsWith(prefix) && !CAMPAIGN_SLOTS.some((s) => campaignName(tag, s, suffix).toLowerCase() === n.toLowerCase()) && !/\[Nurture \d+\]/i.test(n)) {
          blockers.push(`${label}: #${x.id} “${n}” is ${tag}'s but isn't one of the 12 names for ${/^[aeiou]/i.test(suffix) ? "an" : "a"} ${suffix} — was the client type different? Sort it out in Email Bison first.`);
        }
      }
      const byName = (want: string) => tags.find((t) => t.name.trim().toLowerCase() === want.toLowerCase()) ?? null;
      const newTag = byName("New"), nurtureTag = byName("Nurture");
      if (!newTag || !nurtureTag) blockers.push(`${label}: the ${[!newTag && "“New”", !nurtureTag && "“Nurture”"].filter(Boolean).join(" and ")} tag isn't there.`);
      const own = byName(tag);
      clientTagId[instance] = own?.id ?? null;
      if (!own) toCreateTag.push(label);
      for (const slot of CAMPAIGN_SLOTS) {
        const name = campaignName(tag, slot, suffix);
        const already = live.filter((x) => x.name.trim().toLowerCase() === name.toLowerCase());
        if (already.length > 1) blockers.push(`${label}: ${already.length} campaigns are named “${name}” (${already.map((x) => `#${x.id}`).join(", ")}) — there should be one. Delete the extra in Email Bison.`);
        const limits = campaignLimits(kind, slot, tierSupported(tier) ? tier : "1");
        const schedule = campaignSchedule(instance, slot, timezone);
        const modeTag = slot.nurture ? nurtureTag : newTag;
        items.push({ instance, kind, label, slot, name, existingIds: already.map((x) => x.id), limits, schedule, modeTag });
        rows.push([
          `${kind === "b2b" ? "B2B" : "B2C"} #${group}`,
          already.length ? `${name} — already exists (${already.map((x) => `#${x.id}`).join(", ")}), left as it is` : name,
          `${limits.max_emails_per_day} / ${limits.max_new_leads_per_day}`,
          `${schedule.start_time}–${schedule.end_time}`,
          `${slot.nurture ? "Nurture" : "New"} + ${tag}`,
        ]);
      }
    }
  }

  const exists = items.filter((i) => i.existingIds.length).length;
  // Held to the details the campaigns already made were written with.
  const pinned = Object.fromEntries(inputs.filter((i) => (PINNED_KEYS as readonly string[]).includes(i.key)).map((i) => [i.key, String(i.value ?? "")]));
  if (madeWith && exists > 0) {
    const changed = PINNED_KEYS.filter((k) => typeof madeWith![k] === "string" && (madeWith![k] ?? "").trim() !== (pinned[k] ?? "").trim());
    if (changed.length) blockers.push(`${exists} of the 12 campaigns were already made with a different ${changed.map((k) => PINNED_LABEL[k]).join(", ")} — put back what they were made with (reload this step), or delete those campaigns in Email Bison first, so all 12 match.`);
  }
  const waits = steps.length ? steps.slice(0, -1).map((s) => s.wait_in_days).join(" → ") : "";
  const lines = [
    group
      ? `${exists ? `Creates the other ${items.length - exists} of ${tag}'s 12 draft campaigns` : `Creates 12 draft campaigns for ${tag}`} — 6 in B2B #${group} ${GROUP_META[group].b2b} and 6 in B2C #${group} ${GROUP_META[group].b2c}, named “${tag}: … (${suffix})”. Nothing is launched; no senders or leads are added.`
      : "Creates 12 draft campaigns — 6 in each of the group's two instances. Nothing is launched.",
    steps.length ? `Emails: ${copyLabel} — ${plural(steps.length, "email")}${waits ? ` (days between: ${waits})` : ""}, with this client's lines and name filled in (below).` : "Emails: from the email copy library.",
    `Schedules: Monday–Friday in ${timezone || "the chosen time zone"}, each instance's usual window; nurture campaigns start 4 hours after their main one and end with it.`,
    `Settings: plain text, no open tracking, no unsubscribe link, follow-ups first; daily limits for tier ${tierSupported(tier) ? tier : "?"}.`,
    `Tags: New (main) or Nurture, plus ${tag}${toCreateTag.length ? ` — the ${tag} tag doesn't exist yet in ${toCreateTag.join(" and ")}, so it's created there` : ""}.`,
    "Works one campaign at a time and reads every part back. A campaign gets its real name only once everything in it has checked out; one that doesn't is kept aside as “CHECK COPY — …” and the run stops there.",
    ...(exists ? [`${exists} of the 12 already exist and are left as they are.${madeWith && madeCount ? " The rest are made with the same client details as those." : ""}`] : []),
    "Marks this step Done once all 12 are there.",
  ];
  return { tag, group, timezone, clientType, inputs, blockers, rows, notes, lines, items, steps, clientTagId, pinned };
}

const createCampaigns: Automation = {
  async preview(ctx) {
    // Right before a run, read Email Bison fresh: a campaign deleted a moment ago must not still block it.
    const p = await planCampaigns(ctx, ctx.mode === "run");
    if (!campaignCreationEnabled()) p.blockers.push(NOT_SWITCHED_ON);
    return {
      title: "Create email campaigns",
      lines: p.lines,
      inputs: p.inputs,
      blockers: p.blockers,
      tables: p.rows.length ? [{ title: "The 12 campaigns", columns: ["", "New campaign", "Per day (emails / leads)", "Mon–Fri", "Tags"], rows: p.rows }] : [],
      notes: p.notes,
    };
  },

  /** ONE campaign per request. `more` tells the caller to run again; the step is Done when all 12 are there. */
  async run(ctx) {
    if (!campaignCreationEnabled()) return { ok: false, summary: NOT_SWITCHED_ON };
    // Rebuilt now, from a fresh read — never trusted from the preview.
    const p = await planCampaigns(ctx, true);
    if (p.blockers.length) return { ok: false, summary: p.blockers.join(" ") };
    if (p.items.length !== 2 * CAMPAIGN_SLOTS.length || !p.steps.length) return { ok: false, summary: "The plan isn't complete — reload this step to see why." };
    const total = p.items.length;
    const allThere = `All ${total} campaigns are there for ${p.tag} — drafts, ready for their senders.`;

    // What earlier requests of this step made. Email Bison's search can lag
    // behind a campaign made a moment ago, so those are asked for by id — a
    // campaign must never be made twice because the search hadn't caught up.
    const made = new Map<string, number>();
    for (const res of await runResults(ctx.task.id)) {
      for (const x of (Array.isArray(res.results) ? res.results : []) as { instance?: unknown; name?: unknown; state?: unknown; campaignId?: unknown }[]) {
        const key = `${x.instance}|${x.name}`;
        if (x.state === "created" && typeof x.campaignId === "number" && !made.has(key)) made.set(key, x.campaignId);
      }
    }
    let there = 0;
    let next: PlannedCampaign | null = null;
    for (const item of p.items) {
      if (item.existingIds.length) { there++; continue; }
      const id = made.get(`${item.instance}|${item.name}`);
      if (id != null) {
        const c = await lookUpCampaign(item.instance, id);
        if (c === null) return { ok: false, summary: `Couldn't confirm whether “${item.name}” (#${id}, made a moment ago) is in Email Bison — nothing was created. Try again.` };
        if (c !== "gone" && !gone(c.status) && c.name === item.name) { there++; continue; }
      }
      next ??= item;
    }
    if (!next) return { ok: true, summary: allThere };

    // The campaigns send in this zone, so it becomes the client's — the client page shows what they use.
    if (ctx.client.campaign_timezone !== p.timezone) await setClientTimezone(ctx.client.client_tag, p.timezone);

    // The client's own tag in this instance (created once, then found by name).
    let clientTag = p.clientTagId[next.instance] ?? null;
    if (clientTag == null) {
      await createTag(next.instance, p.tag);
      const again = (await listTags(next.instance)).find((t) => t.name.trim().toLowerCase() === p.tag.toLowerCase());
      if (!again) return { ok: false, summary: `Couldn't create the tag ${p.tag} in ${next.label} — nothing else was made. Try again.` };
      clientTag = again.id;
    }
    if (!next.modeTag) return { ok: false, summary: `${next.label}: the ${next.slot.nurture ? "Nurture" : "New"} tag is missing.` };

    const r = await buildCampaign({
      instance: next.instance, name: next.name, limits: next.limits, steps: p.steps, schedule: next.schedule,
      tags: [next.modeTag, { id: clientTag, name: p.tag }],
    }, realBisonOps);
    const record = { instance: next.instance, name: r.name, state: r.state, campaignId: r.campaignId, note: r.note, unsure: !!r.unsure, at: new Date().toISOString(), lines: p.pinned };
    if (r.state === "failed") {
      return {
        ok: false,
        summary: `Stopped at “${r.name}” (${next.label}): ${r.note} ${there} of ${total} are there. The ones already made are kept.`,
        result: { results: [record] },
      };
    }
    const more = there + 1 < total;
    return {
      ok: true, more,
      summary: more ? `Created “${r.name}” — ${there + 1} of ${total}.` : allThere,
      result: { results: [record] },
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
export const domainAllocationEnabled = () => process.env.ONBOARDING_ALLOCATE_DOMAINS === "1" && leadsyncRunSecretSet();
const ALLOCATION_NOT_SWITCHED_ON =
  "Allocating domains isn't switched on yet — this shows what LeadSync would give the client. Do the step by hand for now.";
const ALLOCATION_BATCH = 5;
const DAILY_LIMIT = 3;
/** How long a client's hold on its group's reserve lasts after its last batch. */
const ALLOCATION_LOCK_MS = 10 * 60_000;
const allocationLock = (group: 1 | 2) => `allocate:group:${group}`;
/** LeadSync's refusals, said in plain words (its own text is written for developers). */
function leadsyncSays(error: string): string {
  if (/allocation is switched off/i.test(error)) return "LeadSync's domain allocation is switched off — set ONBOARDING_ALLOCATE_ENABLED=1 in LeadSync's Vercel settings and redeploy it.";
  if (/sending is switched off/i.test(error)) return "LeadSync's whitelist sending is switched off — set ONBOARDING_WHITELIST_ENABLED=1 in LeadSync's Vercel settings and redeploy it.";
  if (/ONBOARDING_RUN_SECRET is not set/i.test(error)) return "LeadSync has no run secret — set ONBOARDING_RUN_SECRET in LeadSync's Vercel settings (the same value as LEADSYNC_RUN_SECRET here) and redeploy it.";
  if (/run secret is missing or wrong/i.test(error)) return "The run secret here doesn't match LeadSync's — LEADSYNC_RUN_SECRET (Reply Router) and ONBOARDING_RUN_SECRET (LeadSync) must be the same value.";
  return /[.!?]$/.test(error.trim()) ? error.trim() : `${error.trim()}.`;
}

const groupBusy = (group: 1 | 2, holder: string) =>
  `Group ${group}'s domains are being allocated for ${holder} right now — two clients of a group can't take from the same reserve at once. Run this when that has finished (the hold lapses ${ALLOCATION_LOCK_MS / 60_000} minutes after its last batch).`;

/** "Tier 1 (Base)" → "1". Anything else is left to LeadSync (it reads the Client Tracker). */
function tierOfPlan(plan: string | null): "0.5" | "1" | "2" | undefined {
  const p = plan ?? "";
  return /tier\s*0\.5/i.test(p) ? "0.5" : /tier\s*2/i.test(p) ? "2" : /tier\s*1/i.test(p) ? "1" : undefined;
}

/**
 * "jan-pro.com/socal" → "https://jan-pro.com/socal"; "" when it isn't a plain
 * website address. Every sender domain will redirect there, so anything odd is
 * refused: an email address, a login in the address, a port, a bare IP, two
 * addresses in one field, or a host that isn't name.tld.
 */
function asHttpsUrl(raw: string): string {
  const t = raw.trim().replace(/^http:\/\//i, "https://");
  if (!t || /[\s,;@]/.test(t)) return "";
  try {
    const u = new URL(/^https:\/\//i.test(t) ? t : `https://${t}`);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return "";
    return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(u.hostname) ? u.toString() : "";
  } catch { return ""; }
}

/** Two addresses for the same site? Compared without the scheme, "www." or a trailing slash. */
function sameSite(a: string, b: string): boolean {
  const key = (x: string) => { try { const u = new URL(/^https?:\/\//i.test(x.trim()) ? x.trim() : `https://${x.trim()}`); return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`; } catch { return null; } };
  const ka = key(a), kb = key(b);
  return ka !== null && ka === kb;
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
  // Settled further down, once LeadSync has said which website IT has for the client.
  let redirectRaw = typed ?? fromSheet;
  let redirect = asHttpsUrl(redirectRaw);
  const redirectInput: AutomationInput = {
    key: "redirect", label: "Redirect the domains to", type: "text", value: redirectRaw, placeholder: "https://client-website.com",
    hint: fromSheet ? `The onboarding form's Company Website: ${fromSheet}` : `${tag} has no Company Website on the onboarding form — type the address.`,
  };
  const inputs: AutomationInput[] = [
    { key: "tier", label: "Tier", type: "select", value: tier ?? "",
      options: [{ value: "0.5", label: "Tier 0.5 · 20 B2B + 5 B2C" }, { value: "1", label: "Tier 1 · 20 B2B + 5 B2C" }, { value: "2", label: "Tier 2 · 40 B2B + 10 B2C" }],
      hint: c.plan_type ? `The client's plan here: ${c.plan_type}` : "No plan on the client — left empty, LeadSync uses the Client Tracker's tier." },
    redirectInput,
  ];

  const rows: string[][] = [];
  const notes: PreviewNote[] = [];
  const sides: AllocationSidePlan[] = [];
  let plan: AllocationPlan | null = null;
  let summary = "Asks LeadSync which reserve domains this client would get.";
  const busyFor = c.group_num ? await lockHolder(allocationLock(c.group_num), ALLOCATION_LOCK_MS) : null;
  if (!c.group_num) {
    blockers.push("This client has no group yet — the first step (Tell Outreachify on Slack) picks it, or set it on the client's page.");
  } else if (busyFor && busyFor !== tag) {
    // Another client of the group is taking domains from the same reserve. LeadSync isn't asked
    // for a plan now: whatever it offered would be out of date by the time this client's turn comes.
    blockers.push(groupBusy(c.group_num, busyFor));
    summary = `Group ${c.group_num}'s reserve is in use for ${busyFor} — this client's plan is drawn up once that has finished.`;
  } else {
    const r = await previewOnboardingAllocation(tag, c.group_num, tier, fresh);
    if (!r.ok) {
      blockers.push(`Couldn't get the plan from LeadSync: ${r.error}`);
    } else {
      const p = r.plan;
      plan = p;
      if (p.groupMismatch) blockers.push(`LeadSync's allocation sheet has ${tag} in Group ${p.allocationGroup}, not Group ${c.group_num} — sort out which is right before allocating.`);
      // What LeadSync itself needs in place before it will run (the group is already said above).
      for (const why of p.runBlockers ?? []) if (!/allocation sheet has/.test(why)) blockers.push(`LeadSync isn't ready for ${tag}: ${why}.`);
      // LeadSync redirects a client's domains to the website IT has (the Client Tracker's) and
      // re-points any that drift every day — so that is the address used, and the one here must agree.
      const known = typeof p.knownRedirect === "string" ? p.knownRedirect.trim() : "";
      if (known) {
        if (!redirectRaw) { redirectRaw = known; redirect = asHttpsUrl(known); redirectInput.value = known; }
        redirectInput.hint = `LeadSync (Client Tracker) has ${known}. ${fromSheet ? `The onboarding form's Company Website: ${fromSheet}` : "The onboarding form has no Company Website."}`;
        if (redirect && !sameSite(redirect, known)) {
          blockers.push(`The website here (${redirectRaw}) isn't the one LeadSync has for ${tag} (${known}). LeadSync keeps a client's domains pointed at its own, so make the Client Tracker and this agree first.`);
        }
      }
      summary = `LeadSync's plan for ${tag} at Tier ${p.tier} (tier from ${p.tierSource === "request" ? "the choice above" : `the ${p.tierSource}`}), as of ${fmtDate(p.generatedFor)}.`;
      // The campaigns the "Create the 12 campaigns" step made, by id: Email Bison's search can lag
      // behind campaigns made a moment ago, and this step must not say they're missing.
      const madeIds = new Map<string, number>(); // `${instance}|${name lower}` → id
      const createTask = (await listTasks({ tag: c.client_tag })).find((t) => t.automation === "create_campaigns");
      if (createTask) {
        for (const res of await runResults(createTask.id)) {
          for (const x of (Array.isArray(res.results) ? res.results : []) as { instance?: unknown; name?: unknown; state?: unknown; campaignId?: unknown }[]) {
            if (x.state === "created" && typeof x.campaignId === "number" && typeof x.name === "string") madeIds.set(`${x.instance}|${x.name.trim().toLowerCase()}`, x.campaignId);
          }
        }
      }
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
            // Step 2 names them after the client type ("(Cleaning Client)", "(Internal)", …).
            const names = CLIENT_TYPES.map((t) => campaignName(tag, slot, t.label).toLowerCase());
            const name = campaignName(tag, slot);
            const hits = found.filter((x) => names.includes(x.name.trim().toLowerCase()));
            if (hits.length === 1) campaignIds.push(hits[0].id);
            else if (hits.length > 1) blockers.push(`${s.label}: ${hits.length} campaigns are named “${name}” — there should be one.`);
            else {
              const made = names.map((n) => madeIds.get(`${s.instance}|${n}`)).find((id) => id != null);
              const c2 = made != null ? await lookUpCampaign(s.instance as BisonInstanceKey, made) : null;
              if (made != null && c2 && c2 !== "gone" && !gone(c2.status)) campaignIds.push(made);
              else missing.push(slotKey(slot));
            }
          }
          if (missing.length) { blockers.push(`${s.label}: ${tag} has no ${missing.join(", ")} campaign${missing.length === 1 ? "" : "s"} yet — the “Create the 12 campaigns” step creates them.`); campaignIds = []; }
        } catch (e) {
          blockers.push(`Couldn't read ${tag}'s campaigns on ${s.label}: ${(e as Error).message}`);
        }
        sides.push({ ...s, campaignIds });
        rows.push([s.label, String(s.cap), String(s.alreadyTagged), String(s.need), String(s.reserveAvailable), s.short ? String(s.short) : "—", campaignIds.length ? `${campaignIds.length} campaigns` : "—"]);
        if (s.short > 0) blockers.push(`${s.label}: ${s.short} domain${s.short === 1 ? "" : "s"} short — ${s.need} needed, ${s.reserveAvailable} ready in the reserve.`);
        // LeadSync's note is why its OWN automatic top-up leaves this client alone (it does that for
        // every client that isn't sending yet) — true of any new client, so it is shown, not a stop.
        if (s.note) notes.push({ title: `${s.label} — LeadSync's automatic top-up skips ${tag} for now`, text: `Its reason: “${s.note}”. That is about its own top-ups; this step allocates the first domains regardless.` });
        if (s.setAside) notes.push({ title: `${s.label} — ${s.setAside} reserve domain${s.setAside === 1 ? " was" : "s were"} left out`, text: "They already carry a client's tag, so they are not offered." });
        if (s.picking.length) notes.push({ title: `${s.label} — the ${s.picking.length} domain${s.picking.length === 1 ? "" : "s"} it would give`, text: s.picking.join("\n") });
      }
    }
  }
  // While another client holds the group, LeadSync wasn't asked — its website isn't known yet, so no verdict on it.
  if (!redirect && !(busyFor && busyFor !== tag)) blockers.unshift(redirectRaw ? `“${redirectRaw}” isn't a web address the domains can redirect to.` : "There is no website to redirect the domains to.");
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
        `It works in batches of ${ALLOCATION_BATCH} domains${left ? ` (${Math.ceil(left / ALLOCATION_BATCH)} batch${Math.ceil(left / ALLOCATION_BATCH) === 1 ? "" : "es"} for this client)` : ""} and marks this step Done when nothing is left to add.`,
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
    if (!group || !p.plan || !p.sides.length) return { ok: false, summary: "LeadSync returned no plan — reload this step to see why." };
    const total = (s: AllocationSidePlan) => `${s.label} ${s.cap}`;
    const side = p.sides.find((s) => s.need > 0);
    if (!side) {
      await releaseLock(allocationLock(group), p.tag);
      return { ok: true, summary: `All of ${p.tag}'s domains are allocated — ${p.sides.map(total).join(", ")}.` };
    }

    // One client per group at a time: two clients of a group draw on the same
    // reserve, and LeadSync would offer both the same domains. The lock is kept
    // from this client's first batch to its last (renewed by each batch).
    const heldBy = await takeLock(allocationLock(group), p.tag, ALLOCATION_LOCK_MS);
    if (heldBy) {
      // The plan in hand will be out of date by the time the other client is done.
      rememberAllocationPlan(p.tag, group, p.tier, null);
      return { ok: false, summary: groupBusy(group, heldBy) };
    }

    const domains = side.picking.slice(0, ALLOCATION_BATCH);
    const r = await runOnboardingAllocation({
      clientTag: p.tag, group, tier: p.tier, instance: side.instance,
      domains, redirectUrl: p.redirect, campaignIds: side.campaignIds, dailyLimit: DAILY_LIMIT,
    });
    // The group's reserve just changed: plans kept for its other clients would offer domains that are gone.
    forgetAllocationPlans(group);
    // Whatever went wrong, the kept plan is no longer trusted — the next try asks again.
    if (!r.ok) {
      rememberAllocationPlan(p.tag, group, p.tier, null);
      // A plain refusal means nothing was touched, so the group needn't wait for this
      // client. No answer at all is different: the batch may be under way — keep the hold.
      if (r.status !== 0) await releaseLock(allocationLock(group), p.tag);
      return {
        ok: false,
        summary: r.status === 0
          // No answer is not a "no": LeadSync may still be working through the batch.
          ? `LeadSync didn't answer for ${side.label} (${r.error}) — it may still be working on this batch. Wait a few minutes, then reload this step: it shows what was added.`
          : `LeadSync didn't take the batch for ${side.label}: ${leadsyncSays(r.error)}${r.status === 409 ? " Nothing was changed — run it again for a fresh plan." : ""}`,
        result: { instance: side.instance, domains },
      };
    }
    const res = r.result;
    // "ok" from LeadSync is not enough: a step can be marked degraded, or a
    // limit call can "succeed" on zero senders. Everything must have happened.
    const bad = res.steps.filter((x) => x.state !== "done").map((x) => `${x.label}${x.note ? ` (${x.note})` : ""}${x.state === "done" ? "" : ` — ${x.state}`}`);
    const limit = res.limit.error ? `daily limit: ${res.limit.error}`
      : res.limit.failed ? `daily limit not set on ${res.limit.failed} sender(s)`
      : !res.limit.updated ? "daily limit: no sender was updated" : "";
    const count = res.added === domains.length ? "" : `${res.added} of ${domains.length} domains were added`;
    if (!res.ok || bad.length || limit || count) {
      rememberAllocationPlan(p.tag, group, p.tier, null);
      // LeadSync's own list (when it checks the batch itself) says more than the step states do.
      const found = res.problems?.length ? res.problems : [count, ...bad, limit].filter(Boolean);
      return {
        ok: false,
        summary: `${side.label}: ${domains.length} domains were handed to LeadSync but not everything went through — ${found.join("; ") || "see LeadSync"}. Look at LeadSync's Replacement page before running again.`,
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
    if (!more) await releaseLock(allocationLock(group), p.tag);
    return {
      ok: true, more,
      summary: more
        ? `${side.label}: ${domains.length} more domains added — ${done} of ${side.cap}.`
        : `All of ${p.tag}'s domains are allocated — ${p.sides.map(total).join(", ")}.`,
      result: { instance: side.instance, domains, leadsync: res },
    };
  },
};

// ── 4. Whitelisting domains email to clients ────────────────────────────────
// LeadSync already writes and sends this email: its 6:30 AM PT batch picks up
// every domain step 3 allocated. This step shows that email and — when
// switched on — has LeadSync send it now instead of the next morning.
//
// Sending is OFF unless ONBOARDING_SEND_WHITELIST=1 is set here (LeadSync has
// its own switch too). Until then this is a preview.

/** Server-side switch for actually sending the whitelist email (the preview always works). */
export const whitelistSendEnabled = () => process.env.ONBOARDING_SEND_WHITELIST === "1" && leadsyncRunSecretSet();
const WHITELIST_NOT_SWITCHED_ON =
  "Sending the whitelist email from here isn't switched on yet — this shows the email LeadSync would send. LeadSync still sends it on its own at 6:30 AM PT for the domains waiting in its queue.";

const domainCount = (k: number) => `${k} domain${k === 1 ? "" : "s"}`;

interface WhitelistView {
  tag: string;
  /** LeadSync's answer as received (null when it couldn't be had). */
  plan: WhitelistPlan | null;
  blockers: string[]; lines: string[]; tables: PreviewTable[]; notes: PreviewNote[]; message?: string;
}

/** What the preview shows and the run acts on. Always asked fresh — LeadSync's read for this is light. */
async function planWhitelist(ctx: AutomationContext): Promise<WhitelistView> {
  const tag = ctx.client.client_tag.toUpperCase();
  const r = await previewOnboardingWhitelist(tag);
  if (!r.ok) {
    return { tag, plan: null, blockers: [`Couldn't get the email from LeadSync: ${r.error}`], lines: ["Asks LeadSync for the whitelist email it would send this client."], tables: [], notes: [] };
  }
  const p = r.plan, d = p.domains;
  const blockers: string[] = [];
  if (p.exempt) {
    blockers.push(`${tag} is on LeadSync's no-whitelist-email list, so there is no email to send — complete the step by hand.`);
  } else {
    if (d.assigned === 0) blockers.push(`${tag} has no sending domains in LeadSync yet — the “Domains” step allocates them.`);
    if (p.recipientProblem) blockers.push(`${p.recipientProblem} — the email has nobody to go to.`);
    else if (!p.to.length && !p.bcc.length && d.toSend.length > 0) blockers.push(`The email has nobody to go to — ${tag} has no CC or BCC in Reply Router. Add them on its client page first.`);
    if (d.toSend.length > 0 && !p.webhookConfigured) blockers.push("LeadSync's email sender isn't set up, so it can't send.");
  }

  const lastSent = d.alreadySent.map((x) => x.sentAt || "").sort().pop() || null;
  const lines: string[] = [];
  if (d.toSend.length > 0) {
    lines.push(`LeadSync's whitelist email for ${tag}: ${domainCount(d.toSend.length)} to list, sent from ${p.from}.`);
    lines.push("It is the same email, to the same people, as LeadSync's own 6:30 AM PT batch. Sending it now marks those domains as sent, so the morning batch doesn't send it again.");
    if (d.queued.length) lines.push(`${d.queued.length === d.toSend.length ? "All of them are" : `${d.queued.length} of them are`} already waiting for that batch.`);
    if (d.alreadySent.length) lines.push(`${tag} was already emailed about ${domainCount(d.alreadySent.length)}${lastSent ? ` (last on ${fmtStamp(lastSent)})` : ""} — those are not repeated.`);
  } else if (d.assigned > 0) {
    lines.push(`LeadSync has already sent ${tag} the whitelist email for all ${domainCount(d.assigned)}${lastSent ? ` (last on ${fmtStamp(lastSent)})` : ""}.`);
    lines.push("Running this sends nothing and marks the step Done.");
  } else {
    lines.push(`LeadSync has no domains for ${tag} to put in a whitelist email.`);
  }

  const tables: PreviewTable[] = [];
  if (!p.exempt) {
    tables.push({
      title: "Who gets it",
      columns: ["", "Address"],
      rows: [
        ["From", p.from],
        ["To", p.to.join(", ") || "—"],
        ["CC", p.cc.join(", ") || "—"],
        ...(p.bcc.length ? [["BCC", p.bcc.join(", ")]] : []),
      ],
    });
  }
  if (d.assigned > 0) {
    const waiting = new Set(d.queued);
    tables.push({
      title: `${tag}'s domains`,
      columns: ["Domain", "Whitelist email"],
      rows: [
        ...d.toSend.map((x) => [x, waiting.has(x) ? "To send — waiting for the 6:30 AM PT batch" : "To send — not queued yet"]),
        ...d.alreadySent.map((x) => [x.domain, x.sentAt ? `Sent ${fmtStamp(x.sentAt)}` : "Sent"]),
      ],
    });
  }
  const notes: PreviewNote[] = [];
  const leftOut = (list: string[], why: string) => { if (list.length) notes.push({ title: `${domainCount(list.length)} left out — ${why}`, text: list.join("\n") }); };
  leftOut(d.burnt, "marked Burnt");
  leftOut(d.leaving, "being removed or replaced");
  leftOut(d.noInboxes, "no inboxes on them yet");

  return {
    tag, plan: p, blockers, lines, tables, notes,
    message: !p.exempt && d.toSend.length > 0 ? `Subject: ${p.subject}\n\n${p.text}` : undefined,
  };
}

const whitelistEmail: Automation = {
  async preview(ctx) {
    const v = await planWhitelist(ctx);
    if (!whitelistSendEnabled()) v.blockers.push(WHITELIST_NOT_SWITCHED_ON);
    return { title: "Whitelisting domains email to clients", lines: v.lines, message: v.message, inputs: [], blockers: v.blockers, tables: v.tables, notes: v.notes };
  },

  /** One email. LeadSync re-checks every domain and sends only what this client hasn't been sent. */
  async run(ctx) {
    if (!whitelistSendEnabled()) return { ok: false, summary: WHITELIST_NOT_SWITCHED_ON };
    const v = await planWhitelist(ctx);
    if (v.blockers.length) return { ok: false, summary: v.blockers.join(" ") };
    const p = v.plan;
    if (!p) return { ok: false, summary: "LeadSync returned no email — reload this step to see why." };
    const d = p.domains;
    if (d.toSend.length === 0) {
      return { ok: true, summary: `LeadSync had already sent ${v.tag} the whitelist email for all ${domainCount(d.assigned)} — nothing was sent now.`, result: { sent: 0, alreadySent: d.alreadySent.length } };
    }
    const r = await runOnboardingWhitelist(v.tag, d.toSend);
    if (!r.ok) {
      return {
        ok: false,
        summary: r.status === 0
          ? `No answer from LeadSync (${r.error}), so the email may or may not have gone out. Reload this step before running again — the domains it went out for show as Sent.`
          : `LeadSync didn't send the email: ${leadsyncSays(r.error)}`,
        result: { domains: d.toSend },
      };
    }
    const res = r.result;
    if (!res.ok || res.failures.length) {
      const why = res.failures.map((f) => `${f.reason} (${domainCount(f.domains.length)})`).join("; ");
      return {
        ok: false,
        summary: `The whitelist email didn't fully go out — it covered ${res.sentDomains} of ${domainCount(d.toSend.length)}${why ? `: ${why}` : ""}. Reload this step before running again; it only sends what hasn't gone.`,
        result: { domains: d.toSend, leadsync: res },
      };
    }
    const who = [...p.to, ...p.bcc];
    return {
      ok: true,
      summary: res.sentDomains ? `Whitelist email sent${who.length ? ` to ${who.join(", ")}` : ""} for ${domainCount(res.sentDomains)}.` : "Nothing new to send — the whitelist email had already gone out for every domain.",
      result: { domains: d.toSend, to: p.to, cc: p.cc, bcc: p.bcc, leadsync: res },
    };
  },
};

// ── 6. Send client go-live email ────────────────────────────────────────────
// The email is fixed (requirements of 2026-09-21): to the client's contacts —
// the same people the whitelist email goes to — with Spencer and Madison in CC.
// This shows it. Sending from here is NOT built: which mailbox it goes out
// from is still to be decided, so the step is sent by hand and ticked off.

const GO_LIVE_SUBJECT = "OutboundHero Update";
const GO_LIVE_BODY = [
  "Hi Team,",
  "",
  "Just wanted to let you know we are going live with your campaigns tomorrow morning. You should start to see your first leads come your way in the next couple of days. Spencer will follow up with lead instructions. Let me know if you have any questions.",
  "",
  "Cheers,",
  "Nick Mekeel",
  "OutboundHero",
].join("\n");
const goLiveCc = () =>
  (process.env.ONBOARDING_GO_LIVE_CC || "spencer@outboundhero.co,madison@outboundhero.co").split(",").map((e) => e.trim()).filter(Boolean);
const GO_LIVE_NOT_BUILT =
  "Sending this from the checklist isn't built yet — it waits for the decision on which mailbox it goes out from. Send it by hand for now, then complete the step.";

const goLiveEmail: Automation = {
  async preview(ctx) {
    const tag = ctx.client.client_tag.toUpperCase();
    const blockers: string[] = [];
    let to: string[] = [], bcc: string[] = [];
    try {
      const c = await clientContacts(tag);
      to = c.to; bcc = c.bcc;
      if (!c.known) blockers.push(`${tag} isn't set up under Clients yet — its contact emails come from there.`);
      else if (to.length === 0 && bcc.length === 0) blockers.push(`${tag} has no contact emails under Clients (CC / BCC) — there is nobody to send this to.`);
    } catch (e) {
      blockers.push(`Couldn't read ${tag}'s contact emails: ${(e as Error).message}`);
    }
    const cc = goLiveCc().filter((e) => !to.some((t) => t.toLowerCase() === e.toLowerCase()));
    blockers.push(GO_LIVE_NOT_BUILT);
    return {
      title: "Send client go-live email",
      lines: [
        `The go-live email for ${tag}: to its contacts — the same people LeadSync's whitelist email goes to — with Spencer and Madison in CC.`,
        "It says the campaigns go live “tomorrow morning”, so it goes out the day before go-live.",
      ],
      message: `Subject: ${GO_LIVE_SUBJECT}\n\n${GO_LIVE_BODY}`,
      inputs: [],
      blockers,
      tables: [{
        title: "Who gets it",
        columns: ["", "Address"],
        rows: [
          ["From", "Not decided yet"],
          ["To", to.join(", ") || "—"],
          ["CC", cc.join(", ") || "—"],
          ...(bcc.length ? [["BCC", bcc.join(", ")]] : []),
        ],
      }],
    };
  },
  async run() {
    return { ok: false, summary: GO_LIVE_NOT_BUILT };
  },
};

// ── Set the client up in Reply Router ───────────────────────────────────────
// What used to be done by hand for every new client: the client tag in its
// section (so its replies are routed), CC / BCC and the reply template (from
// the Onboarding Form), then the qualification rules synced from the form.
// Everything is read from the form and shown in editable fields first; only
// Reply Router's own data changes.

/** client_config has six CC slots; at least three are always shown. */
const RR_CC_MAX = 6;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
interface RrPlan {
  tag: string;
  sections: { id: number; name: string }[];
  sectionId: number | null;
  existingSection: { id: number; name: string } | null;
  cc: { name: string; email: string }[];
  bcc: { name: string; email: string };
  template: string;
  inputs: AutomationInput[];
  blockers: string[];
  lines: string[];
  notes: PreviewNote[];
}

async function planReplyRouterSetup(ctx: AutomationContext): Promise<RrPlan> {
  const tag = ctx.client.client_tag.toUpperCase();
  const param = (k: string) => (typeof ctx.params[k] === "string" ? (ctx.params[k] as string) : undefined);
  const blockers: string[] = [];
  const notes: PreviewNote[] = [];

  const [sectionRows, tagRow, cfgRow, recent] = await Promise.all([
    db.execute("SELECT id, name FROM sections ORDER BY id"),
    db.execute({ sql: "SELECT t.section_id, s.name FROM client_tags t LEFT JOIN sections s ON s.id = t.section_id WHERE UPPER(t.tag) = ?", args: [tag] }),
    db.execute({ sql: `SELECT ${Array.from({ length: RR_CC_MAX }, (_, i) => `cc_name_${i + 1}, cc_email_${i + 1}`).join(", ")}, bcc_name_1, bcc_email_1, reply_template FROM client_config WHERE UPPER(client_tag) = ?`, args: [tag] }),
    // Where the latest clients that were fully set up went (today Section 8).
    db.execute({ sql: "SELECT t.section_id FROM client_tags t JOIN client_config c ON c.client_tag = t.tag WHERE c.cc_email_1 IS NOT NULL AND c.cc_email_1 != '' AND UPPER(t.tag) != ? ORDER BY t.id DESC LIMIT 1", args: [tag] }),
  ]);
  const sections = sectionRows.rows.map((r) => ({ id: Number(r.id), name: String(r.name ?? `Section ${r.id}`) }));
  const sectionName = (id: number | null) => sections.find((x) => x.id === id)?.name ?? (id ? `Section ${id}` : "—");
  const existingSection = tagRow.rows[0] ? { id: Number(tagRow.rows[0].section_id), name: sectionName(Number(tagRow.rows[0].section_id)) } : null;
  const recentRow = recent.rows[0] ? Number(recent.rows[0].section_id) : null;
  const recentSection = recentRow != null && sections.some((x) => x.id === recentRow) ? recentRow : sections[sections.length - 1]?.id ?? null;

  let form: Awaited<ReturnType<typeof fetchOnboardingFormDetails>> extends Map<string, infer V> ? V | undefined : never;
  try { form = (await withCache("onboarding:form-details", 60_000, fetchOnboardingFormDetails)).get(tag); } catch (e) {
    form = undefined;
    notes.push({ title: "The Onboarding Form couldn't be read", text: (e as Error).message });
  }
  const cfg = cfgRow.rows[0] as Record<string, unknown> | undefined;
  const has = (v: unknown) => typeof v === "string" && v.trim() !== "";
  const configured = !!cfg && (has(cfg.cc_email_1) || has(cfg.reply_template));

  // Section: "Add to Onboarding" files a new tag in the first section as a placeholder; a client
  // that isn't set up yet goes where the latest set-up clients went. One already set up stays put.
  const placeholder = !!existingSection && existingSection.id === sections[0]?.id && !configured;
  const chosen = Number(param("section"));
  const sectionId = sections.some((x) => x.id === chosen) ? chosen : existingSection && !placeholder ? existingSection.id : recentSection;

  // Suggestions from the form (used only where nothing is saved yet and nothing was typed).
  const people = form ? parseFormPeople(form.ccText) : [];
  const allCc = people.filter((p) => p.kind === "cc");
  const ccPeople = allCc.slice(0, RR_CC_MAX);
  const bccPerson = people.find((p) => p.kind === "bcc");
  const savedSlots = configured ? Array.from({ length: RR_CC_MAX }, (_, i) => i + 1).filter((n) => has(cfg?.[`cc_email_${n}`])).pop() ?? 0 : 0;
  const slots = Math.min(RR_CC_MAX, Math.max(3, configured ? savedSlots : ccPeople.length));
  const suggestedTemplate = form ? buildReplyTemplate({ people: ccPeople, companyName: form.companyName, website: form.website, phones: form.phones, address: form.address }) : "";

  const pick = (key: string, saved: unknown, suggested: string) => param(key) ?? (configured ? (has(saved) ? String(saved) : "") : suggested);
  const cc = Array.from({ length: slots }, (_, i) => ({
    name: pick(`cc${i + 1}_name`, cfg?.[`cc_name_${i + 1}`], ccPeople[i]?.name ?? "").trim(),
    email: pick(`cc${i + 1}_email`, cfg?.[`cc_email_${i + 1}`], ccPeople[i]?.email ?? "").trim(),
  }));
  const bcc = { name: pick("bcc1_name", cfg?.bcc_name_1, bccPerson?.name ?? "").trim(), email: pick("bcc1_email", cfg?.bcc_email_1, bccPerson?.email ?? "").trim() };
  const template = (param("template") ?? (configured && has(cfg?.reply_template) ? String(cfg?.reply_template) : suggestedTemplate)).replace(/\r\n?/g, "\n");

  // Checks.
  const filled = cc.filter((x) => x.email);
  if (!filled.length) blockers.push(form ? "Add at least one CC email — the form's answer had none this could read." : `${tag} has no Onboarding Form row — fill the form first, or type the CC and the template here.`);
  for (const [i, x] of cc.entries()) {
    if (x.email && !isEmail(x.email)) blockers.push(`CC ${i + 1}: “${x.email}” isn't an email address.`);
    if (x.name && !x.email) blockers.push(`CC ${i + 1}: ${x.name} has no email address.`);
  }
  if (bcc.email && !isEmail(bcc.email)) blockers.push(`BCC: “${bcc.email}” isn't an email address.`);
  if (!template.trim()) blockers.push("Write the reply template.");
  else {
    if (!/\{FIRST_NAME\}/.test(template)) notes.push({ title: "Check the template", text: "It doesn't greet the lead by name ({FIRST_NAME})." });
    const unknown = (template.match(/\{[A-Z_]+\}/g) ?? []).filter((t) => !["{FIRST_NAME}", "{CONTEXT}", "{COMPANY}", "{PHONE}", "{SENDER_NAME}"].includes(t));
    if (unknown.length) blockers.push(`The template uses ${[...new Set(unknown)].join(", ")}, which Reply Router doesn't fill in. Use {FIRST_NAME}, {CONTEXT}, {COMPANY}, {PHONE} or {SENDER_NAME}.`);
  }
  if (!sectionId) blockers.push("Choose the section the client's replies go to.");
  else if (!sections.some((x) => x.id === sectionId)) blockers.push(`Section ${sectionId} doesn't exist — choose another.`);
  if (allCc.length > RR_CC_MAX) notes.push({ title: "More people than CC slots", text: `The form lists ${allCc.length} people to CC; Reply Router has ${RR_CC_MAX} CC slots, so only the first ${RR_CC_MAX} are used.` });
  if (form?.email) {
    for (const x of [...cc, bcc]) {
      if (x.email && nearMiss(x.email, form.email)) notes.push({ title: "Possible typo", text: `${x.email} is a letter or two away from the form's own address, ${form.email}. Check which is right.` });
    }
  }

  const inputs: AutomationInput[] = [
    { key: "section", label: "Section", type: "select", value: sectionId ? String(sectionId) : "", options: sections.map((x) => ({ value: String(x.id), label: x.name })),
      hint: !existingSection ? `Where the client's replies are routed. New clients go where the latest set-up clients went (${sectionName(recentSection)}).`
        : placeholder ? `Adding to onboarding put ${tag} in ${existingSection.name} as a placeholder — it moves to where the latest set-up clients went (${sectionName(recentSection)}) unless you choose otherwise.`
        : `${tag} is in ${existingSection.name}.` },
    ...cc.flatMap((x, i) => [
      { key: `cc${i + 1}_name`, label: `CC ${i + 1} — name`, type: "text" as const, value: x.name, placeholder: i === 0 ? "Doug Ferrell" : "" },
      { key: `cc${i + 1}_email`, label: `CC ${i + 1} — email`, type: "text" as const, value: x.email, placeholder: i === 0 ? "doug@company.com" : "" },
    ]),
    { key: "bcc1_name", label: "BCC — name", type: "text", value: bcc.name },
    { key: "bcc1_email", label: "BCC — email", type: "text", value: bcc.email },
    { key: "template", label: "Reply template", type: "textarea", value: template,
      hint: "Sent to a lead who's interested, with the CC people copied. {FIRST_NAME}, {CONTEXT}, {COMPANY}, {PHONE} and {SENDER_NAME} are filled in for each lead." },
  ];
  if (form?.ccText) notes.push({ title: "What the client wrote on the form (who to CC)", text: form.ccText });

  const ccText = filled.map((x) => (x.name ? `${x.name} <${x.email}>` : x.email)).join(", ");
  const lines = [
    !existingSection ? `Adds ${tag} to ${sectionName(sectionId)}, so its replies are routed.`
      : existingSection.id !== sectionId ? `Moves ${tag} from ${existingSection.name} to ${sectionName(sectionId)} — its replies are routed there from now on.`
      : `${tag} stays in ${existingSection.name}.`,
    ccText ? `Saves CC: ${ccText}${bcc.email ? `; BCC: ${bcc.name ? `${bcc.name} <${bcc.email}>` : bcc.email}` : ""}.` : "No CC filled in yet — add who a lead is handed to below.",
    "Saves the reply template below.",
    "Syncs the qualification rules and status from the Onboarding Form (the same sync that runs every hour), then reads everything back.",
  ];
  if (configured) lines.unshift(`${tag} already has CC / a template in Reply Router — the fields show what's saved; running again saves what's in them.`);
  return { tag, sections, sectionId, existingSection, cc, bcc, template, inputs, blockers, lines, notes };
}

const replyRouterSetup: Automation = {
  async preview(ctx) {
    const p = await planReplyRouterSetup(ctx);
    return { title: "Set up the client in Reply Router", lines: p.lines, inputs: p.inputs, blockers: p.blockers, notes: p.notes };
  },
  async run(ctx) {
    const p = await planReplyRouterSetup(ctx);
    if (p.blockers.length) return { ok: false, summary: p.blockers.join(" ") };
    const tag = p.tag;
    if (!p.existingSection) {
      await db.execute({ sql: "INSERT INTO client_tags (tag, section_id) VALUES (?, ?)", args: [tag, p.sectionId] });
    } else if (p.existingSection.id !== p.sectionId) {
      // Same as Clients › Move: routing of its future replies only.
      await db.execute({ sql: "UPDATE client_tags SET section_id = ? WHERE UPPER(tag) = ?", args: [p.sectionId, tag] });
    }
    await db.execute({ sql: "INSERT OR IGNORE INTO client_config (client_tag) VALUES (?)", args: [tag] });
    const v = (s: string) => (s.trim() ? s.trim() : null);
    const ccCols = p.cc.map((_, i) => `cc_name_${i + 1}=?, cc_email_${i + 1}=?`).join(", ");
    await db.execute({
      sql: `UPDATE client_config SET ${ccCols}, bcc_name_1=?, bcc_email_1=?, reply_template=?, updated_at=CURRENT_TIMESTAMP WHERE UPPER(client_tag)=?`,
      args: [...p.cc.flatMap((x) => [v(x.name), v(x.email)]), v(p.bcc.name), v(p.bcc.email), p.template, tag],
    });
    bumpVersion("config");
    let synced = "";
    try { const r = await syncAll(); synced = `qualification sync: ${r.qualificationCount} clients`; }
    catch (e) { synced = `the qualification sync failed (${(e as Error).message}) — it runs again within the hour`; }

    // Read it all back.
    const [t, c, q] = await Promise.all([
      db.execute({ sql: "SELECT section_id FROM client_tags WHERE UPPER(tag) = ?", args: [tag] }),
      db.execute({ sql: `SELECT ${p.cc.map((_, i) => `cc_email_${i + 1}`).join(", ")}, bcc_email_1, reply_template FROM client_config WHERE UPPER(client_tag) = ?`, args: [tag] }),
      supabase.from("client_qualifications").select("client_abbreviation").eq("client_abbreviation", tag).maybeSingle(),
    ]);
    const row = c.rows[0] as Record<string, unknown> | undefined;
    const want = p.cc.map((x) => x.email.trim() || null);
    const ok = t.rows.length === 1 && Number(t.rows[0].section_id) === p.sectionId && !!row && String(row.reply_template ?? "") === p.template
      && p.cc.every((_, i) => (row[`cc_email_${i + 1}`] ?? null) === want[i]) && (row.bcc_email_1 ?? null) === (p.bcc.email.trim() || null);
    if (!ok) return { ok: false, summary: `Saved, but reading it back didn't match — open Clients › ${tag} and check its CC and template.` };
    const rules = q.data ? "qualification rules are in" : "no qualification rules found for it in the Onboarding Form yet";
    return { ok: true, summary: `${tag} is set up in Reply Router: ${p.sections.find((x) => x.id === p.sectionId)?.name ?? "section"}, ${plural(p.cc.filter((x) => x.email).length, "CC")}${p.bcc.email ? " + BCC" : ""}, reply template saved; ${rules} (${synced}).`, result: { tag, section: p.sectionId } };
  },
};

/** Whether a task's automation may be RUN on this server right now (previews are separate). */
/** What each automation can do on this server right now: "on" (it runs when approved),
 *  "off" (built, but its switch isn't set — preview only) or "preview" (sending isn't built). */
export type AutomationState = "on" | "off" | "preview";
const SWITCHED = new Set(["create_campaigns", "allocate_domains", "whitelist_email"]);
export function automationStates(): Record<string, AutomationState> {
  return Object.fromEntries(Object.keys(AUTOMATION_META).map((k) => [k,
    automationRunnable(k) ? "on" : SWITCHED.has(k) ? "off" : "preview"] as const));
}

export function automationRunnable(key: string | null | undefined): boolean {
  if (!key) return false;
  if (key === "create_campaigns") return campaignCreationEnabled();
  if (key === "allocate_domains") return domainAllocationEnabled();
  if (key === "whitelist_email") return whitelistSendEnabled();
  return !!AUTOMATION_META[key]?.built;
}

const AUTOMATIONS: Record<string, Automation> = {
  slack_outreachify: slackOutreachify,
  replyrouter_setup: replyRouterSetup,
  create_campaigns: createCampaigns,
  allocate_domains: allocateDomains,
  whitelist_email: whitelistEmail,
  go_live_email: goLiveEmail,
};

export function getAutomation(key: string | null | undefined): Automation | null {
  return (key && AUTOMATIONS[key]) || null;
}
