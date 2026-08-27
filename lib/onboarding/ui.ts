/**
 * Shared onboarding UI constants — status/role labels + theme-token-aware pill
 * styles. Pure data (no JSX) so both the board page and the detail page import
 * the same palette. Status colors follow the app's soft-50/200/700 idiom and
 * carry dark-mode variants so light/dark both look intentional.
 */
import type { OnboardingRole, TaskStatus } from "@/lib/onboarding/generate";

export const TASK_STATUS_ORDER: TaskStatus[] = ["not_started", "in_progress", "completed"];

export const STATUS_META: Record<TaskStatus, { label: string; pill: string; dot: string; col: string }> = {
  not_started: {
    label: "Not Started",
    pill: "bg-muted text-muted-foreground border-border",
    dot: "bg-muted-foreground/40",
    col: "border-border",
  },
  in_progress: {
    label: "In Progress",
    pill: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/60",
    dot: "bg-amber-500",
    col: "border-amber-200 dark:border-amber-900/60",
  },
  completed: {
    label: "Completed",
    pill: "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-900/60",
    dot: "bg-green-500",
    col: "border-green-200 dark:border-green-900/60",
  },
};

export const ROLE_META: Record<OnboardingRole, { label: string; short: string; pill: string }> = {
  domains: { label: "Domains Owner", short: "Domains", pill: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900/60" },
  inbox:   { label: "Inbox Owner",   short: "Inbox",   pill: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900/60" },
  ops:     { label: "Ops Owner",     short: "Ops",     pill: "bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-900/60" },
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

/** Today's civil date as YYYY-MM-DD (Pacific), for overdue/today grouping. */
export function todayStr(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return parts; // en-CA → YYYY-MM-DD
}
