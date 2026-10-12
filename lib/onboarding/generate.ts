/**
 * Onboarding task generator (pure) — the timeline engine.
 *
 * Given an onboarding client (start date) and the standard task template,
 * produce the concrete task rows. Two kinds of template task:
 *   • dated   — `due_date = start_date + day_offset` CALENDAR days (Day N; a
 *               client starting on the 1st has Day 1 on the 2nd);
 *   • ordered — no due date (`no_due`): they run in checklist order whenever
 *               their owner clicks Run / Complete.
 * Each task is assigned to the template's person (`assignee_id`); legacy
 * templates without one fall back to the client's owner for the task's role.
 *
 * Kept dependency-free (no db, no network) so the API, the UI and tests all
 * share the same rules.
 */

export type OnboardingRole = "domains" | "inbox" | "ops";
export const ONBOARDING_ROLES: OnboardingRole[] = ["domains", "inbox", "ops"];
export const ROLE_LABEL: Record<OnboardingRole, string> = {
  domains: "Domains Owner",
  inbox: "Inbox Owner",
  ops: "Ops Owner",
};

export type TaskStatus = "not_started" | "in_progress" | "completed";

export interface TemplateTask {
  id: string;
  title: string;
  role: OnboardingRole;
  day_offset: number;
  order_index: number;
  task_group: string | null;
  /** Default assignee (an onboarding_user id). */
  assignee_id?: string | null;
  /** 1 = no due date; runs in checklist order. */
  no_due?: number;
  /** Automation behind the task's Run button (lib/onboarding/automations.ts); null = manual check-off. */
  automation?: string | null;
}

export interface OnboardingClientInput {
  client_tag: string;
  start_date: string; // YYYY-MM-DD
  domains_owner_email: string | null;
  inbox_owner_email: string | null;
  ops_owner_email: string | null;
}

export interface GeneratedTask {
  client_tag: string;
  template_task_id: string | null;
  title: string;
  role: OnboardingRole;
  task_group: string | null;
  day_offset: number;
  due_date: string | null; // YYYY-MM-DD; null for ordered (no-due) tasks
  assignee_email: string | null; // an onboarding_user id (legacy column name)
  order_index: number;
  no_due: number;
  automation: string | null;
}

/**
 * Group rule: a client starting on the 1st goes to Group 2, on the 15th to
 * Group 1. Any other start day has no automatic group (it must be chosen).
 */
export function groupForStartDate(startDate: string | null | undefined): 1 | 2 | null {
  if (!isValidDate(startDate)) return null;
  const day = Number(String(startDate).split("-")[2]);
  return day === 1 ? 2 : day === 15 ? 1 : null;
}

/**
 * Ordered tasks run in checklist order: the first ordered task of this client
 * (by order_index) that isn't completed yet and comes BEFORE `task`, or null
 * when `task` is free to start. Dated tasks are never blocked.
 */
export function blockingTask<T extends { id: string; client_tag: string; no_due: number; order_index: number; status: TaskStatus }>(
  task: T, clientTasks: T[],
): T | null {
  if (!task.no_due) return null;
  const earlier = clientTasks
    .filter((t) => t.client_tag === task.client_tag && t.no_due && t.id !== task.id && t.order_index < task.order_index && t.status !== "completed")
    .sort((a, b) => a.order_index - b.order_index);
  return earlier[0] ?? null;
}

/** Add N calendar days to a YYYY-MM-DD date, returning YYYY-MM-DD. Timezone-
 *  neutral (operates on the civil date only) — Apr 22 + 10 → May 02. */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  // Anchor at UTC noon so DST / offset never rolls the civil date.
  const base = Date.UTC(y, (m || 1) - 1, d || 1, 12, 0, 0);
  const shifted = new Date(base + n * 86_400_000);
  const yy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** True for a valid YYYY-MM-DD string. */
export function isValidDate(s: string | null | undefined): boolean {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1970;
}

/** Resolve a role to the client's owner email for that role (null if unset). */
export function ownerForRole(client: OnboardingClientInput, role: OnboardingRole): string | null {
  const email =
    role === "domains" ? client.domains_owner_email :
    role === "inbox" ? client.inbox_owner_email :
    client.ops_owner_email;
  const trimmed = (email || "").trim();
  return trimmed ? trimmed : null;
}

/** Produce the concrete task rows for a client from the template. */
export function generateTasks(client: OnboardingClientInput, template: TemplateTask[]): GeneratedTask[] {
  return template
    .slice()
    .sort((a, b) => a.order_index - b.order_index || a.day_offset - b.day_offset)
    .map((t, i) => ({
      client_tag: client.client_tag,
      template_task_id: t.id,
      title: t.title,
      role: t.role,
      task_group: t.task_group,
      day_offset: t.day_offset,
      due_date: t.no_due ? null : addDays(client.start_date, t.day_offset),
      assignee_email: (t.assignee_id || "").trim() || ownerForRole(client, t.role),
      order_index: t.order_index || i,
      no_due: t.no_due ? 1 : 0,
      automation: t.automation ?? null,
    }));
}
