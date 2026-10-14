/**
 * Which campaigns a new client gets (onboarding step 2) — pure, no I/O.
 *
 * Every client has 12: in its group's B2B instance and its B2C instance, a
 * main and a nurture campaign for each of the three recipient ESP lanes, named
 * exactly like the live ones:
 *   "TAG: Google + Custom (Cleaning Client)"
 *   "TAG: Outlook [Nurture] (Cleaning Client)"  …
 * Each is a copy of the master client's campaign in the same slot.
 */
import type { BisonInstanceKey } from "@/lib/bison-instances-shared";
import type { Place } from "@/lib/onboarding/campaign-copy";

export const CAMPAIGN_LANES = ["Google + Custom", "Outlook", "SEGs"] as const;
export type CampaignLane = (typeof CAMPAIGN_LANES)[number];
/** The name suffix of the client type this automation covers. */
export const CLEANING_SUFFIX = "Cleaning Client";

export interface CampaignSlot { lane: CampaignLane; nurture: boolean }
export const CAMPAIGN_SLOTS: CampaignSlot[] = CAMPAIGN_LANES.flatMap((lane) => [{ lane, nurture: false }, { lane, nurture: true }]);
export const slotKey = (s: CampaignSlot) => `${s.lane}${s.nurture ? " [Nurture]" : ""}`;

/** Group → its two instances (same as GROUP_INSTANCE_MAP in lib/nurture/group-routing.ts). */
export const GROUP_INSTANCES: Record<1 | 2, { b2b: BisonInstanceKey; b2c: BisonInstanceKey }> = {
  1: { b2b: "outboundhero", b2c: "cleaningoutbound" },
  2: { b2b: "facilityreach", b2c: "outboundclean" },
};

export function campaignName(tag: string, slot: CampaignSlot, suffix = CLEANING_SUFFIX): string {
  return `${tag.toUpperCase()}: ${slotKey(slot)} (${suffix})`;
}

/** Which slot a campaign name belongs to for this client tag + suffix, or null. */
export function slotOfName(name: string, tag: string, suffix = CLEANING_SUFFIX): CampaignSlot | null {
  return CAMPAIGN_SLOTS.find((s) => campaignName(tag, s, suffix).toLowerCase() === name.trim().toLowerCase()) ?? null;
}

/** The master client of one group: whose campaigns are copied, and how its place is written in them. */
export interface MasterSpec { tag: string; place: Place }
export type MasterSettings = Partial<Record<"1" | "2", MasterSpec>>;

export function parseMasterSettings(raw: string | null | undefined): MasterSettings {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as MasterSettings;
    const out: MasterSettings = {};
    for (const g of ["1", "2"] as const) {
      const m = v?.[g];
      if (m && typeof m.tag === "string" && m.tag.trim() && m.place) {
        out[g] = {
          tag: m.tag.trim().toUpperCase(),
          place: { area: String(m.place.area ?? "").trim(), city: String(m.place.city ?? "").trim(), state: String(m.place.state ?? "").trim(), abbr: String(m.place.abbr ?? "").trim() },
        };
      }
    }
    return out;
  } catch { return {}; }
}

// ── Places ──────────────────────────────────────────────────────────────────
// [abbreviation, name, timezone the client's campaigns send in]
const REGIONS: [string, string, string][] = [
  ["AL", "Alabama", "America/Chicago"], ["AK", "Alaska", "America/Anchorage"], ["AZ", "Arizona", "America/Phoenix"],
  ["AR", "Arkansas", "America/Chicago"], ["CA", "California", "America/Los_Angeles"], ["CO", "Colorado", "America/Denver"],
  ["CT", "Connecticut", "America/New_York"], ["DE", "Delaware", "America/New_York"], ["DC", "District of Columbia", "America/New_York"],
  ["FL", "Florida", "America/New_York"], ["GA", "Georgia", "America/New_York"], ["HI", "Hawaii", "Pacific/Honolulu"],
  ["ID", "Idaho", "America/Denver"], ["IL", "Illinois", "America/Chicago"], ["IN", "Indiana", "America/New_York"],
  ["IA", "Iowa", "America/Chicago"], ["KS", "Kansas", "America/Chicago"], ["KY", "Kentucky", "America/New_York"],
  ["LA", "Louisiana", "America/Chicago"], ["ME", "Maine", "America/New_York"], ["MD", "Maryland", "America/New_York"],
  ["MA", "Massachusetts", "America/New_York"], ["MI", "Michigan", "America/New_York"], ["MN", "Minnesota", "America/Chicago"],
  ["MS", "Mississippi", "America/Chicago"], ["MO", "Missouri", "America/Chicago"], ["MT", "Montana", "America/Denver"],
  ["NE", "Nebraska", "America/Chicago"], ["NV", "Nevada", "America/Los_Angeles"], ["NH", "New Hampshire", "America/New_York"],
  ["NJ", "New Jersey", "America/New_York"], ["NM", "New Mexico", "America/Denver"], ["NY", "New York", "America/New_York"],
  ["NC", "North Carolina", "America/New_York"], ["ND", "North Dakota", "America/Chicago"], ["OH", "Ohio", "America/New_York"],
  ["OK", "Oklahoma", "America/Chicago"], ["OR", "Oregon", "America/Los_Angeles"], ["PA", "Pennsylvania", "America/New_York"],
  ["RI", "Rhode Island", "America/New_York"], ["SC", "South Carolina", "America/New_York"], ["SD", "South Dakota", "America/Chicago"],
  ["TN", "Tennessee", "America/Chicago"], ["TX", "Texas", "America/Chicago"], ["UT", "Utah", "America/Denver"],
  ["VT", "Vermont", "America/New_York"], ["VA", "Virginia", "America/New_York"], ["WA", "Washington", "America/Los_Angeles"],
  ["WV", "West Virginia", "America/New_York"], ["WI", "Wisconsin", "America/Chicago"], ["WY", "Wyoming", "America/Denver"],
  // Canada — the live campaigns use the matching US zone (Winnipeg sends on America/Chicago).
  ["AB", "Alberta", "America/Denver"], ["BC", "British Columbia", "America/Los_Angeles"], ["MB", "Manitoba", "America/Chicago"],
  ["ON", "Ontario", "America/New_York"], ["QC", "Quebec", "America/New_York"], ["SK", "Saskatchewan", "America/Regina"],
  ["NB", "New Brunswick", "America/Halifax"], ["NS", "Nova Scotia", "America/Halifax"],
  ["PE", "Prince Edward Island", "America/Halifax"], ["NL", "Newfoundland and Labrador", "America/Halifax"],
];

export const REGION_OPTIONS = REGIONS.map(([abbr, name]) => ({ abbr, name }));
/** The zones offered in the Run dialog. */
export const TIMEZONE_OPTIONS = [...new Set(REGIONS.map((r) => r[2]))];

/**
 * The time zones a client's campaigns can send in — exactly the choices of
 * Clay's "Time Zone" column (a hand-picked dropdown on every client row of the
 * "Clay –> EmailBison" tables; the schedule columns read it), in Clay's order.
 */
export const CAMPAIGN_TIMEZONES = [
  "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Phoenix", "America/Denver",
  "America/Chicago", "America/New_York", "America/Halifax", "Europe/London", "Australia/Sydney", "Pacific/Auckland",
] as const;
export const isCampaignTimezone = (v: unknown): v is (typeof CAMPAIGN_TIMEZONES)[number] =>
  typeof v === "string" && (CAMPAIGN_TIMEZONES as readonly string[]).includes(v);
const TIMEZONE_NAMES: Record<string, string> = {
  "Pacific/Honolulu": "Hawaii", "America/Anchorage": "Alaska", "America/Los_Angeles": "Pacific", "America/Phoenix": "Arizona",
  "America/Denver": "Mountain", "America/Chicago": "Central", "America/New_York": "Eastern", "America/Halifax": "Atlantic",
  "Europe/London": "UK", "Australia/Sydney": "Australia East", "Pacific/Auckland": "New Zealand",
};
/** "America/Los_Angeles" → "Pacific (Los Angeles)". */
export const timezoneLabel = (tz: string) => {
  const city = tz.replace(/^.*\//, "").replace(/_/g, " ");
  return TIMEZONE_NAMES[tz] ? `${TIMEZONE_NAMES[tz]} (${city})` : city;
};
/** A suggestion from a state or province — only when it is one of Clay's choices (Saskatchewan isn't). */
export function suggestTimezone(stateOrAbbr: string | null | undefined): string | null {
  const tz = stateOrAbbr ? timezoneForState(stateOrAbbr) : null;
  return tz && isCampaignTimezone(tz) ? tz : null;
}

export function regionByAny(text: string): { abbr: string; name: string; timezone: string } | null {
  const t = text.trim().toLowerCase();
  const hit = REGIONS.find(([abbr, name]) => abbr.toLowerCase() === t || name.toLowerCase() === t);
  return hit ? { abbr: hit[0], name: hit[1], timezone: hit[2] } : null;
}
export const timezoneForState = (stateOrAbbr: string): string | null => regionByAny(stateOrAbbr)?.timezone ?? null;

/**
 * Best-effort city + state from the sheet's office location ("Anaheim,
 * California", "2255 Sheridan Blvd. Ste. C #275, Edgewater, CO 80214"). The
 * result only pre-fills the Run dialog — a person checks it there. `sure` is
 * false when the city had to be guessed out of a street address.
 */
export function parsePlace(text: string | null | undefined): { city: string; state: string; abbr: string; sure: boolean } | null {
  const parts = (text ?? "").replace(/\s+/g, " ").split(",").map((p) => p.trim()).filter(Boolean);
  // In an address an abbreviation is written in capitals — "Co" is not Colorado.
  const regionIn = (part: string) => {
    const t = part.replace(/\b\d{5}(-\d{4})?\b|\b[A-Z]\d[A-Z] ?\d[A-Z]\d\b/g, "").trim(); // drop ZIP / postal code
    const hit = REGIONS.find(([abbr, name]) => abbr === t || name.toLowerCase() === t.toLowerCase());
    return hit ? { abbr: hit[0], name: hit[1] } : null;
  };
  for (let i = parts.length - 1; i >= 1; i--) {
    let region = regionIn(parts[i]);
    if (!region) continue;
    // "Winnipeg, MB, CA": when the part before is itself a state, the last part is a country.
    const earlier = i >= 2 ? regionIn(parts[i - 1]) : null;
    if (earlier) { region = earlier; i -= 1; }
    const before = parts[i - 1];
    // A street address or two places in one cell ("Dallas, TX and Houston, TX") is a guess to check.
    const sure = !/\d/.test(before) && !/\band\b|&/i.test(before);
    // "315 University Ave Los Gatos" → keep what follows the street words; if a
    // number is still in there ("… RdSuite B1 Baltimore"), what follows the last one.
    let city = sure ? before : before.replace(/^.*\b(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Hwy|Highway|Ste|Suite|Pkwy|Ct|Pl)\b\.?\s*(?:[#A-Z]?\d+\w*\s*)?/i, "").trim();
    if (/\d/.test(city)) city = city.replace(/^.*\S*\d\S*\s*/, "").trim();
    return city ? { city, state: region.name, abbr: region.abbr, sure } : null;
  }
  return null;
}
