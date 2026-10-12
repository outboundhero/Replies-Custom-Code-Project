/**
 * Shared onboarding UI constants — status / group / automation labels +
 * theme-token-aware pill styles. Pure data (no JSX) so the pages, the Slack
 * messages and the automations all use the same words. Status colors follow the
 * app's soft-50/200/700 idiom and carry dark-mode variants.
 */
import type { TaskStatus } from "@/lib/onboarding/generate";

export const TASK_STATUS_ORDER: TaskStatus[] = ["not_started", "in_progress", "completed"];

export const STATUS_META: Record<TaskStatus, { label: string; pill: string; dot: string; col: string }> = {
  not_started: {
    label: "Not started",
    pill: "bg-muted text-muted-foreground border-border",
    dot: "bg-muted-foreground/40",
    col: "border-border",
  },
  in_progress: {
    label: "In progress",
    pill: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/60",
    dot: "bg-amber-500",
    col: "border-amber-200 dark:border-amber-900/60",
  },
  completed: {
    label: "Done",
    pill: "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-900/60",
    dot: "bg-green-500",
    col: "border-green-200 dark:border-green-900/60",
  },
};

/** Each group's Bison instances (mirrors GROUP_INSTANCE_MAP in lib/nurture/group-routing.ts). */
export const GROUP_META: Record<1 | 2, { label: string; b2b: string; b2c: string }> = {
  1: { label: "Group 1", b2b: "OutboundHero", b2c: "Cleaning Outbound" },
  2: { label: "Group 2", b2b: "Facility Reach", b2c: "Outbound Clean" },
};
/** "Group 2 — B2B #2 Facility Reach + B2C #2 Outbound Clean". */
export function groupText(g: 1 | 2 | null | undefined): string {
  if (g !== 1 && g !== 2) return "No group yet";
  const m = GROUP_META[g];
  return `${m.label} — B2B #${g} ${m.b2b} + B2C #${g} ${m.b2c}`;
}

/**
 * Automations a checklist task can carry. `built: false` = the automation
 * can't be run yet, so the task is completed by hand for now (the UI says so).
 * `preview: true` = it can already show exactly what it would do.
 */
export const AUTOMATION_META: Record<string, { label: string; built: boolean; preview?: boolean }> = {
  slack_outreachify: { label: "Sends the client tag + group to Outreachify on Slack", built: true },
  create_campaigns: { label: "Creates the 12 Email Bison campaigns", built: false, preview: true },
  allocate_domains: { label: "Allocates reserve domains, tags + attaches them, sets 3/day", built: false },
  whitelist_email: { label: "Sends the whitelisting-domains email", built: false },
  go_live_email: { label: "Sends the client go-live email", built: false },
};

/** "you@x.com" → "you" for compact display. */
export function shortEmail(email: string | null | undefined): string {
  if (!email) return "";
  return email.split("@")[0];
}

/** Human date: "Apr 22" / "Apr 22, 2027" if not current year. YYYY-MM-DD in. */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, day || 1, 12));
  const thisYear = new Date().getUTCFullYear();
  return dt.toLocaleDateString("en-US", {
    month: "short", day: "numeric",
    ...(y !== thisYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

/** A timestamp's civil date (Pacific, like todayStr) in the fmtDate style: "Oct 12". */
export function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "—";
  return fmtDate(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(t));
}

/** Today's civil date as YYYY-MM-DD (Pacific), for overdue/today grouping. */
export function todayStr(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return parts; // en-CA → YYYY-MM-DD
}
