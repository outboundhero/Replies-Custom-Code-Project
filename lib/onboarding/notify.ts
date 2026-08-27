/**
 * Onboarding assignee notifications (Slack DMs).
 *
 * Reuses lib/slack.ts `dmByEmails` (resolves each app-user email → Slack DM).
 *  - On add: each owner gets a one-line summary of the tasks now assigned to them.
 *  - On reassign: the new assignee gets a ping for that single task.
 *  - Daily digest (cron): each owner gets their Overdue + Today tasks.
 * All fire-and-forget — never block or break the store operation.
 */
import { dmByEmails } from "@/lib/slack";
import { listTasks } from "@/lib/onboarding/store";
import { fmtDate, todayStr } from "@/lib/onboarding/ui";
import { logError } from "@/lib/errors";

/** Minimal task shape both a freshly-generated task and a stored row satisfy. */
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
    const label = clientName ? `${clientName} (${clientTag})` : clientTag;
    for (const [email, ts] of byOwner) {
      const sorted = ts.slice().sort((a, b) => (a.due_date || "").localeCompare(b.due_date || ""));
      const first = sorted[0];
      const text =
        `:clipboard: You've been assigned *${ts.length} onboarding task${ts.length === 1 ? "" : "s"}* for *${label}*.\n` +
        (first ? `First up: *${first.title}* — due ${fmtDate(first.due_date)}.\n` : "") +
        `See them all: ${clientLink(clientTag)}`;
      await dmByEmails([email], text);
    }
  } catch (e) {
    await logError("onboarding", "notify-on-add", (e as Error).message, { client_tag: clientTag });
  }
}

/** DM the new assignee about a single task they were just given. */
export async function notifyAssignee(email: string | null, clientTag: string, title: string, dueDate: string | null): Promise<void> {
  try {
    if (!email) return;
    const text =
      `:inbox_tray: You've been assigned an onboarding task for *${clientTag}*:\n` +
      `*${title}*${dueDate ? ` — due ${fmtDate(dueDate)}` : ""}\n${clientLink(clientTag)}`;
    await dmByEmails([email], text);
  } catch (e) {
    await logError("onboarding", "notify-assignee", (e as Error).message, { client_tag: clientTag });
  }
}

/** Daily digest: DM each owner their Overdue + Today open tasks. Returns how many
 *  people were notified. Called by the onboarding-digest cron. */
export async function sendDailyDigest(): Promise<{ notified: number }> {
  const today = todayStr();
  const tasks = await listTasks();
  const byOwner = new Map<string, { overdue: typeof tasks; today: typeof tasks }>();
  for (const t of tasks) {
    if (t.status === "completed" || !t.assignee_email || !t.due_date) continue;
    if (t.due_date > today) continue; // only overdue + today
    const bucket = byOwner.get(t.assignee_email) || { overdue: [], today: [] };
    (t.due_date < today ? bucket.overdue : bucket.today).push(t);
    byOwner.set(t.assignee_email, bucket);
  }
  let notified = 0;
  for (const [email, b] of byOwner) {
    if (!b.overdue.length && !b.today.length) continue;
    const line = (t: (typeof tasks)[number]) => `• *${t.title}* — ${t.client_tag} (${fmtDate(t.due_date)})`;
    const parts: string[] = [":sunrise: *Your onboarding tasks*"];
    if (b.overdue.length) parts.push(`*Overdue (${b.overdue.length})*\n${b.overdue.map(line).join("\n")}`);
    if (b.today.length) parts.push(`*Due today (${b.today.length})*\n${b.today.map(line).join("\n")}`);
    parts.push(`${"https://"}${host()}/onboarding`);
    await dmByEmails([email], parts.join("\n\n"));
    notified++;
  }
  return { notified };
}
