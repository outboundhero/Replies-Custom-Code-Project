/**
 * The standard onboarding task template (from the "Client Onboarding System"
 * build doc). Seeded on first use; fully editable afterward in the Template tab.
 * `role` is the default owner bucket for each task and can be re-assigned in-UI.
 */
import type { OnboardingRole } from "@/lib/onboarding/generate";

export interface SeedTask {
  title: string;
  role: OnboardingRole;
  day_offset: number;
  task_group: string;
}

// order = array order. Day offsets and groups mirror the doc's template table.
export const DEFAULT_TEMPLATE: SeedTask[] = [
  { title: "Purchase domains on Porkbun",          role: "domains", day_offset: 1,  task_group: "Domain Setup" },
  { title: "Create email accounts",               role: "inbox",   day_offset: 1,  task_group: "Inbox Setup" },
  { title: "Message Cheap Inboxes",               role: "inbox",   day_offset: 1,  task_group: "Inbox Setup" },
  { title: "Slack Outreachify",                   role: "ops",     day_offset: 1,  task_group: "Technical Setup" },
  { title: "Email Client - Accounts Created",     role: "ops",     day_offset: 3,  task_group: "Technical Setup" },
  { title: "Email Client - Whitelisting Domains", role: "ops",     day_offset: 3,  task_group: "Technical Setup" },
  { title: "Create Clay Table",                   role: "ops",     day_offset: 6,  task_group: "Technical Setup" },
  { title: "Create Campaigns",                    role: "ops",     day_offset: 8,  task_group: "Campaign Launch" },
  { title: "Email Client - Campaigns Live",       role: "ops",     day_offset: 9,  task_group: "Campaign Launch" },
  { title: "GO LIVE",                             role: "ops",     day_offset: 10, task_group: "Campaign Launch" },
  { title: "Assign Outlook Accounts",            role: "inbox",   day_offset: 10, task_group: "Inbox Setup" },
  { title: "Assign Google Accounts",             role: "inbox",   day_offset: 10, task_group: "Inbox Setup" },
];
