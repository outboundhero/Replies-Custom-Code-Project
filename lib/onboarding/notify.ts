/**
 * Onboarding assignee notifications (Slack DMs).
 *
 * Assignees are onboarding_users (NOT Reply Router app_users); each carries a
 * Slack member ID, so we DM the member ID directly (no email lookup). Task
 * owner/assignee fields store the onboarding_user id, which we resolve to a
 * name + Slack member ID here.
 *  - On add: each owner gets a one-line summary of the tasks now assigned to them.
 *  - On reassign: the new assignee gets a ping for that single task.
 *  - Daily digest (cron): each owner gets their Overdue + Today tasks.
 * All fire-and-forget — never block or break the store operation.
 */
import { dmBySlackIds } from "@/lib/slack";
import { listTasks, onboardingUserMap } from "@/lib/onboarding/store";
import { fmtDate, todayStr } from "@/lib/onboarding/ui";
import { logError } from "@/lib/errors";

/** Minimal task shape both a freshly-generated task and a stored row satisfy.
 *  `assignee_email` holds an onboarding_user id (legacy column name). */
interface NotifiableTask {
  assignee_email: string | null;
  title: string;
  due_date: string | null;
  client_tag: string;
}

function host(): string {
  return (
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.APP_BASE_URL ||
    process.env.VERCEL_URL || "replies-custom-code-project.vercel.app"
  ).replace(/^https?:\/\//, "");
}
const clientLink = (tag: string) => `https://${host()}/onboarding/${encodeURIComponent(tag)}`;

/** DM one onboarding user (by their id) via their Slack member ID. Records an
 *  undelivered note (missing user / no Slack id / Slack error) in Error Logs. */
async function dmUser(userId: string, slackId: string | null, text: string, clientTag: string, stage: string): Promise<void> {
  if (!slackId) {
    await logError("onboarding", `${stage}-undelivered`, `user ${userId} has no Slack member ID`, { client_tag: clientTag });
    return;
  }
  const res = await dmBySlackIds([slackId], text);
  if (!res.ok) {
    await logError("onboarding", `${stage}-undelivered`, res.failed.map((f) => `${f.id}: ${f.error}`).join("; "), { client_tag: clientTag });
  }
}

/** DM each owner a summary of the tasks they were just assigned for a new client. */
export async function notifyOwnersOnAdd(clientTag: string, clientName: string | null, tasks: NotifiableTask[]): Promise<void> {
  try {
    const byOwner = new Map<string, NotifiableTask[]>();
    for (const t of tasks) {
      if (!t.assignee_email) continue;
      const arr = byOwner.get(t.assignee_email) || [];
      arr.push(t);
      byOwner.set(t.assignee_email, arr);
    }
    if (!byOwner.size) return;
    const userMap = await onboardingUserMap();
    const label = clientName ? `${clientName} (${clientTag})` : clientTag;
    for (const [userId, ts] of byOwner) {
      const u = userMap.get(userId);
      const first = ts.slice().sort((a, b) => (a.due_date || "").localeCompare(b.due_date || ""))[0];
      const text =
        `:clipboard: You've been assigned *${ts.length} onboarding task${ts.length === 1 ? "" : "s"}* for *${label}*.\n` +
        (first ? `First up: *${first.title}* — due ${fmtDate(first.due_date)}.\n` : "") +
        `See them all: ${clientLink(clientTag)}`;
      await dmUser(userId, u?.slackId ?? null, text, clientTag, "notify-on-add");
    }
  } catch (e) {
    await logError("onboarding", "notify-on-add", (e as Error).message, { client_tag: clientTag });
  }
}

/** DM the new assignee (onboarding_user id) about a single task they were given. */
export async function notifyAssignee(userId: string | null, clientTag: string, title: string, dueDate: string | null): Promise<void> {
  try {
    if (!userId) return;
    const u = (await onboardingUserMap()).get(userId);
    const text =
      `:inbox_tray: You've been assigned an onboarding task for *${clientTag}*:\n` +
      `*${title}*${dueDate ? ` — due ${fmtDate(dueDate)}` : ""}\n${clientLink(clientTag)}`;
    await dmUser(userId, u?.slackId ?? null, text, clientTag, "notify-assignee");
  } catch (e) {
    await logError("onboarding", "notify-assignee", (e as Error).message, { client_tag: clientTag });
  }
}

/** Daily digest: DM each owner their Overdue + Today open tasks. Returns how many
 *  people were notified. Called by the onboarding-digest cron. */
export async function sendDailyDigest(): Promise<{ notified: number }> {
  const today = todayStr();
  const [tasks, userMap] = await Promise.all([listTasks(), onboardingUserMap()]);
  const byOwner = new Map<string, { overdue: typeof tasks; today: typeof tasks }>();
  for (const t of tasks) {
    if (t.status === "completed" || !t.assignee_email || !t.due_date) continue;
    if (t.due_date > today) continue; // only overdue + today
    const bucket = byOwner.get(t.assignee_email) || { overdue: [], today: [] };
    (t.due_date < today ? bucket.overdue : bucket.today).push(t);
    byOwner.set(t.assignee_email, bucket);
  }
  let notified = 0;
  for (const [userId, b] of byOwner) {
    if (!b.overdue.length && !b.today.length) continue;
    const slackId = userMap.get(userId)?.slackId ?? null;
    if (!slackId) continue;
    const line = (t: (typeof tasks)[number]) => `• *${t.title}* — ${t.client_tag} (${fmtDate(t.due_date)})`;
    const parts: string[] = [":sunrise: *Your onboarding tasks*"];
    if (b.overdue.length) parts.push(`*Overdue (${b.overdue.length})*\n${b.overdue.map(line).join("\n")}`);
    if (b.today.length) parts.push(`*Due today (${b.today.length})*\n${b.today.map(line).join("\n")}`);
    parts.push(`${"https://"}${host()}/onboarding`);
    const res = await dmBySlackIds([slackId], parts.join("\n\n"));
    if (res.ok) notified++;
  }
  return { notified };
}
