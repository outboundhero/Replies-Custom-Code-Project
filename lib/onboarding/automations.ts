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
  getSetting, setClientGroup, listOnboardingUsers,
  type OnboardingClientRow, type OnboardingTaskRow,
} from "@/lib/onboarding/store";
import { GROUP_META, groupText, fmtDate } from "@/lib/onboarding/ui";
import { groupForStartDate } from "@/lib/onboarding/generate";

export interface AutomationInput { key: string; label: string; type: "group"; value: number | string | null; hint?: string }
export interface AutomationPreview {
  title: string;
  /** What will happen, in order. */
  lines: string[];
  /** The exact message / payload, when there is one. */
  message?: string;
  inputs: AutomationInput[];
  /** Reasons it can't run yet (empty = ready). */
  blockers: string[];
}
export interface RunOutcome { ok: boolean; summary: string; result?: unknown }
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

const slackOutreachify: Automation = {
  async preview(ctx) {
    const group = chosenGroup(ctx);
    const dests = await outreachifyDestinations();
    const blockers: string[] = [];
    if (!group) blockers.push("Choose Group 1 or Group 2.");
    if (!dests.length) blockers.push("No Slack destination is set for Outreachify — an admin can add it under Onboarding → Users.");
    return {
      title: "Slack Outreachify to onboard new clients",
      lines: [
        `Sends this message to: ${dests.length ? dests.map((d) => d.label).join(", ") : "—"}`,
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
    const failed: string[] = [];
    const sent: string[] = [];
    for (const d of dests) {
      if (d.kind === "person") {
        const r = await dmBySlackIds([d.id], text);
        if (r.ok) sent.push(d.label); else failed.push(`${d.label}: ${r.failed.map((f) => f.error).join("; ")}`);
      } else {
        const r = await postToChannel(d.id, text);
        if (r.ok) sent.push(d.label); else failed.push(`${d.label}: ${r.error}`);
      }
    }
    // The step counts only when every destination got the message.
    if (failed.length) {
      return { ok: false, summary: `Slack didn't accept the message for ${failed.join(" | ")}${sent.length ? ` (delivered to ${sent.join(", ")})` : ""}`, result: { sent, failed } };
    }
    await setClientGroup(ctx.client.client_tag, group);
    return { ok: true, summary: `Sent ${ctx.client.client_tag} → ${GROUP_META[group].label} to ${sent.join(", ")}`, result: { group, sent } };
  },
};

const AUTOMATIONS: Record<string, Automation> = {
  slack_outreachify: slackOutreachify,
};

export function getAutomation(key: string | null | undefined): Automation | null {
  return (key && AUTOMATIONS[key]) || null;
}
