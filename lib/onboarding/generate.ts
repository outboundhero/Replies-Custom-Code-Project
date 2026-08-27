/**
 * Onboarding task generator (pure) — the timeline engine.
 *
 * Given an onboarding client (start date + role owners) and the standard task
 * template, produce the concrete task rows: each task's `due_date` is
 * `start_date + day_offset` CALENDAR days, and its `assignee_email` is resolved
 * from the task's role → the client's owner for that role.
 *
 * Kept dependency-free (no db, no network) so the Phase-2 automation engine can
 * drive it from a cron/event exactly the same way the Add-to-Onboarding form does.
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
  due_date: string; // YYYY-MM-DD
  assignee_email: string | null;
  order_index: number;
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
      due_date: addDays(client.start_date, t.day_offset),
      assignee_email: ownerForRole(client, t.role),
      order_index: t.order_index || i,
    }));
}
