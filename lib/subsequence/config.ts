/**
 * Interested-reply subsequence — per-client configuration registry.
 *
 * The engine (store, crons, sender, inbox card, badge) is client-agnostic and
 * keyed on each reply's `client_tag`. This registry holds the only things that
 * differ per client: display label, the untracked-failover campaign pool, and
 * the meeting-tracker sheet. Messaging differs too, but lives in the templates
 * module (keyed by the same tags).
 *
 * §26: never mix clients — each lead only ever uses its OWN tag's config.
 */

export const SUBSEQUENCE_TAGS = ["DM4PM", "OH"] as const;
export type SubsequenceTag = (typeof SUBSEQUENCE_TAGS)[number];

export function isSubsequenceTag(tag: string | null | undefined): boolean {
  return !!tag && (SUBSEQUENCE_TAGS as readonly string[]).includes(tag.toUpperCase());
}

/**
 * How to read a client's meeting sheet. Columns are located by header NAME (not
 * a fixed letter), configured per client since the sheets differ:
 *   - DM4PM: outcome col "Showed", qualified col "Qualified".
 *   - OH:    outcome col "Meeting Held", qualified col "Good Fit?".
 * `outcomePolarity` says how to read the outcome column: "showed" (YES=attended,
 * e.g. "Showed" or "Meeting Held") vs "noshow" (YES=didn't attend).
 */
export interface MeetingSheetConfig {
  sheetId: string;
  tabs: string[];
  outcomePolarity: "showed" | "noshow";
  /** Header matchers (lowercased): email exact, others startsWith/contains. */
  cols: { email: string; date: string; qualified: string; outcome: string };
}

export interface SubsequenceClientConfig {
  tag: SubsequenceTag;
  /** Human label shown in the inbox card header. */
  label: string;
  /** Any of this client's cold campaigns on `outboundhero` — used ONLY to fetch
   *  the client-tag inbox pool for failover on untracked replies (campaign_id 0). */
  defaultFailoverCampaign: number;
  /** Meeting sheet, or null when not yet wired (meeting-gating is skipped). */
  meeting: MeetingSheetConfig | null;
}

export const SUBSEQUENCE_CONFIG: Record<SubsequenceTag, SubsequenceClientConfig> = {
  DM4PM: {
    tag: "DM4PM",
    label: "DM4PM",
    defaultFailoverCampaign: 663,
    meeting: {
      sheetId: "1QcEka3pGlV791KeMoVnSug6lxfcR5Xu2-xOyEXmCpxQ",
      tabs: [
        "Grow.DM4PM.com Lead Form Signups",
        " OutBound Grow.DM4PM.com Lead Form Signups", // leading space is real
        "Nurture",
      ],
      outcomePolarity: "showed",
      cols: { email: "email", date: "meeting start", qualified: "qualif", outcome: "showed" },
    },
  },
  OH: {
    tag: "OH",
    label: "OutboundHero",
    defaultFailoverCampaign: 320,
    // OH: LeadRushLabs "OH: Meeting Tracker" sheet. "Meeting Held" = attended
    // signal (Yes=attended, No=no-show, Duplicate, Rescheduled by OH/Lead, Not a
    // Lead); "Good Fit?" = qualified signal (for qualified-no-show → Re-Contact).
    meeting: {
      sheetId: "1WKBHkJ1E-qJLkumilvddJWBmJvvdnqjt_ytqIx3PoMI",
      tabs: ["LRL Meetings as of 7/30/25"],
      outcomePolarity: "showed", // "Meeting Held" Yes=attended, same polarity as "Showed"
      cols: { email: "email", date: "meeting start", qualified: "good fit", outcome: "meeting held" },
    },
  },
};

export function getSubsequenceConfig(tag: string | null | undefined): SubsequenceClientConfig | null {
  if (!tag) return null;
  return SUBSEQUENCE_CONFIG[tag.toUpperCase() as SubsequenceTag] ?? null;
}
