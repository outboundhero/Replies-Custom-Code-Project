/**
 * The standard onboarding checklist (OutboundHero × Outreachify engineering
 * requirements, 2026-09-21, Part 2). Seeded on first use; editable afterward in
 * the Template tab.
 *
 *   • Nick's tasks have no due day — they run in this order whenever he clicks
 *     Run / Complete. `automation` names the automation behind the Run button
 *     (lib/onboarding/automations.ts); tasks without one are manual check-offs.
 *   • Madison's and Spencer's tasks are manual check-offs due on Day N
 *     (client start date + N days).
 */

export interface SeedTask {
  title: string;
  /** Owner's first name — matched to an onboarding user (created if missing). */
  owner: "Nick" | "Madison" | "Spencer";
  /** Day N, or null for an ordered (no due day) task. */
  day: number | null;
  task_group: string;
  automation?: string;
}

// order = array order.
export const DEFAULT_TEMPLATE: SeedTask[] = [
  // ── Nick — automated, in order ───────────────────────────────────────────
  { title: "Slack Outreachify to onboard new clients", owner: "Nick", day: null, task_group: "Setup", automation: "slack_outreachify" },
  { title: "Create email campaigns", owner: "Nick", day: null, task_group: "Setup", automation: "create_campaigns" },
  { title: "Attach client tags / redirects / add to campaigns / set sender accounts to 3/day", owner: "Nick", day: null, task_group: "Setup", automation: "allocate_domains" },
  { title: "Whitelisting domains email to clients", owner: "Nick", day: null, task_group: "Setup", automation: "whitelist_email" },
  { title: "Push data into campaigns — AI Ark pull", owner: "Nick", day: null, task_group: "Data" },
  { title: "Push data into campaigns — Database pull", owner: "Nick", day: null, task_group: "Data" },
  { title: "Push data into campaigns — Clay people + company search", owner: "Nick", day: null, task_group: "Data" },
  { title: "Send client go-live email", owner: "Nick", day: null, task_group: "Go live", automation: "go_live_email" },
  // Madison's (since 2026-10-16; it was Nick's). Dated (due on the start date), so it never waits on — or
  // holds up — the ordered steps above. Added after them, as the template upgrade does for existing
  // templates; the guided page shows it right after Slack.
  { title: "Set up the client in Reply Router (tag, CC/BCC, reply template, rules)", owner: "Madison", day: 0, task_group: "Setup", automation: "replyrouter_setup" },

  // ── Madison — manual ─────────────────────────────────────────────────────
  { title: "Create Client Lead Tracking Sheet & Connect To Sheet Link LeadSync For Client Tag", owner: "Madison", day: 2, task_group: "Lead tracking" },
  { title: "Send Lead Tracking Sheet To All Client CCs, BCCs, & Primary Contact", owner: "Madison", day: 2, task_group: "Lead tracking" },
  { title: "Setup Email Template in ReplyRouter for Client Tag After 1st Lead Arrival & Send First Lead Email To All Client CCs, BCCs, & Primary Contact", owner: "Madison", day: 8, task_group: "Lead tracking" },
  { title: "Simple Check-In #1 (Launch Health Check)", owner: "Madison", day: 15, task_group: "Check-ins" },
  { title: "Simple Check-In #2", owner: "Madison", day: 25, task_group: "Check-ins" },
  { title: "Simple Check-In #3", owner: "Madison", day: 70, task_group: "Check-ins" },
  { title: "Simple Check-In #4", owner: "Madison", day: 90, task_group: "Check-ins" },
  { title: "Simple Check-In #5", owner: "Madison", day: 150, task_group: "Check-ins" },
  { title: "Simple Check-In #6", owner: "Madison", day: 190, task_group: "Check-ins" },
  { title: "Simple Check-In #7", owner: "Madison", day: 220, task_group: "Check-ins" },

  // ── Spencer — manual ─────────────────────────────────────────────────────
  { title: "Testimonial", owner: "Spencer", day: 40, task_group: "Testimonials" },
  { title: "Update/Expand Testimonial", owner: "Spencer", day: 120, task_group: "Testimonials" },
];
