/**
 * Onboarding step 2 — the client's 12 Email Bison campaigns, built from
 * scratch the way Clay's "Clay –> EmailBison" workbook builds them, but from
 * the email copy library (Onboarding › Email copy) instead of a template:
 *
 *   name      "TAG: Google + Custom (Cleaning Client)", "… [Nurture] (…)"
 *   settings  plain text, no open tracking, no unsubscribe link, follow-ups
 *             first (Clay's exact settings body)
 *   limits    per instance kind × lane × tier (Clay's formulas)
 *   emails    the client's own copy, else its type's shared copy, with the
 *             client fields ([[SERVICE_AREA]], [[OFFICE_ADDRESS]], …) filled in
 *   schedule  Mon–Fri in the client's time zone, Clay's window per instance and
 *             lane (SEGs uses Outlook's); nurture starts 4 hours later and keeps
 *             the end (the same rule as lib/nurture/nurture-schedule.ts)
 *   tags      New (main) or Nurture, plus the client's own tag
 *
 * Nothing is launched and no sender or lead is added. Each campaign is made
 * under a working name and gets its real name only after every part of it
 * has been read back and found right; one that doesn't is kept aside as
 * "CHECK COPY — …" for a person to look at.
 *
 * The plan is pure. The builder takes its Email Bison calls as a parameter,
 * so it can be tested against a fake.
 */
import type { BisonInstanceKey } from "@/lib/bison-instances-shared";
import { shiftSchedule } from "@/lib/nurture/shift-schedule";
import { asBisonStores, type BisonStepPayload } from "@/lib/onboarding/copy-model";
import type { CampaignSlot } from "@/lib/onboarding/campaign-plan";

export const BUILD_PREFIX = "BUILDING — ";
export const CHECK_PREFIX = "CHECK COPY — ";

/** Clay's settings body for every campaign (proven on OPSLABS test campaigns). */
export const CAMPAIGN_SETTINGS = {
  plain_text: true,
  open_tracking: false,
  reputation_building: true,
  can_unsubscribe: false,
  include_auto_replies_in_stats: true,
  sequence_prioritization: "followups",
} as const;

export type InstanceKind = "b2b" | "b2c";

/** Clay's tier from a plan text ("Tier 1 (Base) = 20 …" → "1"); null when there's no tier number. */
export function tierOf(plan: string | null | undefined): string | null {
  const m = String(plan ?? "").match(/tier\s*([\d.]+)/i) ?? String(plan ?? "").match(/^\s*([\d.]+)\s*$/);
  return m ? m[1] : null;
}
/** Clay's limits know tiers 0.5, 1 and 2 (tier 2 doubles the emails; new leads follow Clay's own formula). */
export const tierSupported = (tier: string | null) => tier === "0.5" || tier === "1" || tier === "2";

/**
 * Max emails / new leads per day (Clay's formulas):
 *   B2B Google + Custom 3185 / 1274; B2B Outlook and SEGs 735 / 294;
 *   B2C Google + Custom and the Outlook main 858 / 344; B2C Outlook nurture and SEGs 184 / 74;
 *   tier 2: 6370 / 5096, 1470 / 1176, 1715 / 1372, 368 / 295.
 */
export function campaignLimits(kind: InstanceKind, slot: CampaignSlot, tier: string): { max_emails_per_day: number; max_new_leads_per_day: number } {
  const t2 = tier === "2";
  if (kind === "b2b") {
    if (slot.lane === "Google + Custom") return t2 ? { max_emails_per_day: 6370, max_new_leads_per_day: 5096 } : { max_emails_per_day: 3185, max_new_leads_per_day: 1274 };
    return t2 ? { max_emails_per_day: 1470, max_new_leads_per_day: 1176 } : { max_emails_per_day: 735, max_new_leads_per_day: 294 };
  }
  const big = slot.lane === "Google + Custom" || (slot.lane === "Outlook" && !slot.nurture);
  if (big) return t2 ? { max_emails_per_day: 1715, max_new_leads_per_day: 1372 } : { max_emails_per_day: 858, max_new_leads_per_day: 344 };
  return t2 ? { max_emails_per_day: 368, max_new_leads_per_day: 295 } : { max_emails_per_day: 184, max_new_leads_per_day: 74 };
}

/** Clay's sending windows per instance: Google + Custom, and Outlook (SEGs uses Outlook's). */
export const SCHEDULE_WINDOWS: Record<BisonInstanceKey, { gc: [string, string]; outlook: [string, string] }> = {
  outboundhero: { gc: ["05:57", "15:37"], outlook: ["05:57", "15:37"] },
  facilityreach: { gc: ["05:27", "15:47"], outlook: ["05:47", "15:57"] },
  cleaningoutbound: { gc: ["04:57", "15:47"], outlook: ["05:27", "15:57"] },
  outboundclean: { gc: ["05:57", "15:57"], outlook: ["05:57", "15:57"] },
};

export interface CampaignScheduleBody {
  monday: boolean; tuesday: boolean; wednesday: boolean; thursday: boolean; friday: boolean; saturday: boolean; sunday: boolean;
  start_time: string; end_time: string; timezone: string; save_as_template: false;
}

/** Mon–Fri in the client's time zone; a nurture campaign starts 4 hours after its main and ends with it. */
export function campaignSchedule(instance: BisonInstanceKey, slot: CampaignSlot, timezone: string): CampaignScheduleBody {
  const w = SCHEDULE_WINDOWS[instance];
  const [start, end] = slot.lane === "Google + Custom" ? w.gc : w.outlook;
  const main: CampaignScheduleBody = {
    monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false,
    start_time: start, end_time: end, timezone, save_as_template: false,
  };
  if (!slot.nurture) return main;
  const n = shiftSchedule(main as unknown as Record<string, unknown>);
  return { ...main, start_time: n?.start_time ?? start, end_time: n?.end_time ?? end };
}

// ── The client lines (Clay asked an AI for these; the shape is fixed, so they're written here) ──

const SPIN_UNSAFE = /[{}|[\]<>]/;
export interface PlaceParts { area: string; city: string; state: string; abbr: string }

/**
 * The service-area line, in the exact shape Clay's prompt asks for, e.g. for
 * Tampa: "{Commercial Cleaning{| Provider| Service{s|}} {-|in the} {Carrollwood
 * Area|Tampa, {FL|Florida} area}|Carrollwood Area Commercial {Cleaners|Cleaning}|…}".
 * Other client types get a neutral line (the copy for them is written separately).
 */
export function serviceAreaLine(cleaning: boolean, p: PlaceParts): string {
  const area = p.area.trim() || `${p.city.trim()} Area`;
  const st = p.abbr.trim() && p.state.trim() ? `{${p.abbr.trim()}|${p.state.trim()}}` : (p.abbr.trim() || p.state.trim());
  const cityState = st ? `${p.city.trim()}, ${st}` : p.city.trim();
  if (!cleaning) return `{Serving|Based in|Located in} {${area}|${cityState}}`;
  const areaOrCity = p.city.trim() && p.city.trim() !== area ? `{${area}|${p.city.trim()}}` : area;
  return `{Commercial Cleaning{| Provider| Service{s|}} {-|in the} {${area}|${cityState} area}|${areaOrCity} Commercial {Cleaners|Cleaning}|{Local |}{Building|Commercial} Cleaning{| Provider| Service{|s}}{ -|{| based} in} {${cityState}}}`;
}

const STREET: [RegExp, string][] = [
  [/^(?:blvd\.?|boulevard)$/i, "{Boulevard|Blvd.}"],
  [/^(?:st\.?|street)$/i, "{Street|St.}"],
  [/^(?:ave\.?|avenue)$/i, "{Avenue|Ave.}"],
  [/^(?:dr\.?|drive)$/i, "{Drive|Dr.}"],
  [/^(?:rd\.?|road)$/i, "{Road|Rd.}"],
];
const SUITE_RE = /^(?:ste\.?|suite)$/i;
const SUITE_SPIN = "{Ste.|STE|Suite}";
const DIRECTION: Record<string, string> = { e: "{East|E}", east: "{East|E}", w: "{West|W}", west: "{West|W}", n: "{North|N}", north: "{North|N}", s: "{South|S}", south: "{South|S}" };

/** The street line's words with spintax: a street word only where it ends the street name, a direction only after the house number or the suite. */
function streetSpintax(line: string): string {
  const words = line.split(" ");
  const out: string[] = [];
  words.forEach((w, i) => {
    const next = words[i + 1];
    const prev = out[out.length - 1] ?? "";
    const dir = DIRECTION[w.replace(/\.$/, "").toLowerCase()];
    const street = STREET.find(([re]) => re.test(w));
    // "St" only as a street ending (before the suite, a direction, a number or the end) — never "St Andrews".
    if (i > 0 && street && (next === undefined || SUITE_RE.test(next) || !!DIRECTION[next.replace(/\.$/, "").toLowerCase()] || /^#?\d/.test(next))) { out.push(street[1]); return; }
    if (SUITE_RE.test(w)) { out.push(SUITE_SPIN); return; }
    if (dir && i > 0 && ((i === 1 && /^\d/.test(words[0])) || prev === SUITE_SPIN)) { out.push(dir); return; }
    out.push(w);
  });
  return out.join(" ");
}

/**
 * The office address with spintax, by the rules in Clay's prompt: street
 * words ({Avenue|Ave.} …), suite ({Ste.|STE|Suite}), directions ({East|E}),
 * the state ({California|CA}) and an optional ZIP ({| 92866}). Street numbers
 * and city names are kept as they are.
 */
export function addressSpintax(address: string, state: { abbr: string; name: string } | null): string {
  const parts = address.replace(/\s+/g, " ").split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return "";
  let zip = "";
  let last = parts[parts.length - 1];
  const zm = last.match(/\s*(\d{5}(?:-\d{4})?|[A-Z]\d[A-Z] ?\d[A-Z]\d)\s*$/i);
  if (zm) { zip = zm[1]; last = last.slice(0, zm.index).trim(); }
  const isState = !!state && !!last && (last.toUpperCase() === state.abbr.toUpperCase() || last.toLowerCase() === state.name.toLowerCase());
  let stateOut = "";
  if (parts.length > 1 && (isState || zm)) {
    parts.pop();
    stateOut = isState && state ? `{${state.name}|${state.abbr}}` : last;
  } else if (zm) {
    parts[parts.length - 1] = last;
  }
  if (/^\d/.test(parts[0] ?? "")) parts[0] = streetSpintax(parts[0]);
  return [...parts, stateOut].filter(Boolean).join(", ") + (zip ? `{| ${zip}}` : "");
}

/** Text that would break spintax if put inside a client line. */
export const unsafeForSpintax = (s: string) => SPIN_UNSAFE.test(s);

// ── Building one campaign ───────────────────────────────────────────────────

export interface WriteOutcome { ok: boolean; status: number; message?: string }
/** The Email Bison calls the builder needs (lib/outboundhero-api.ts in real use). */
export interface BisonOps {
  /** null = refused (nothing made); "unsure" = no proper answer (it may have been made). */
  createCampaign(instance: BisonInstanceKey, name: string): Promise<{ id: number } | "unsure" | null>;
  updateCampaign(instance: BisonInstanceKey, id: number, fields: Record<string, unknown>): Promise<WriteOutcome>;
  getCampaign(instance: BisonInstanceKey, id: number): Promise<Record<string, unknown> | null>;
  addSteps(instance: BisonInstanceKey, id: number, title: string, steps: BisonStepPayload[]): Promise<WriteOutcome>;
  getSteps(instance: BisonInstanceKey, id: number): Promise<Record<string, unknown>[] | null>;
  createSchedule(instance: BisonInstanceKey, id: number, schedule: CampaignScheduleBody): Promise<WriteOutcome>;
  getSchedule(instance: BisonInstanceKey, id: number): Promise<Record<string, unknown> | null>;
  attachTags(instance: BisonInstanceKey, tagIds: number[], campaignIds: number[]): Promise<WriteOutcome>;
  getTags(instance: BisonInstanceKey, id: number): Promise<{ id: number; name: string }[] | null>;
}

export interface BuildJob {
  instance: BisonInstanceKey;
  name: string;
  limits: { max_emails_per_day: number; max_new_leads_per_day: number };
  steps: BisonStepPayload[];
  schedule: CampaignScheduleBody;
  /** New or Nurture, plus the client's tag. */
  tags: { id: number; name: string }[];
}
export interface BuildResult {
  state: "created" | "failed";
  name: string;
  campaignId: number | null;
  note: string;
  /** Bison didn't answer the create — a "BUILDING — …" campaign may exist that nobody knows the id of. */
  unsure?: boolean;
}

const hm = (v: unknown) => String(v ?? "").slice(0, 5);
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

/** What's wrong with a campaign's emails as read back (empty = exactly as sent, after Bison's own conversion). */
export function stepMismatches(sent: BisonStepPayload[], read: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  const got = [...read].sort((a, b) => Number(a.order) - Number(b.order));
  if (got.length !== sent.length) return [`it has ${got.length} emails instead of ${sent.length}`];
  sent.forEach((s, i) => {
    const g = got[i];
    const n = i + 1;
    // Bison stores a reply's subject with "Re: " in front.
    const subject = s.thread_reply ? `Re: ${s.email_subject}` : s.email_subject;
    if (String(g.email_subject ?? "") !== subject) out.push(`email ${n}'s subject differs`);
    if (String(g.email_body ?? "") !== asBisonStores(s.email_body)) out.push(`email ${n}'s text differs`);
    if (Number(g.wait_in_days) !== s.wait_in_days) out.push(`email ${n} waits ${g.wait_in_days} days instead of ${s.wait_in_days}`);
    if (!!g.thread_reply !== s.thread_reply) out.push(`email ${n} is ${g.thread_reply ? "a reply" : "a new thread"} instead of ${s.thread_reply ? "a reply" : "a new thread"}`);
    if (g.variant) out.push(`email ${n} became a variant`);
  });
  return out;
}

export async function buildCampaign(job: BuildJob, ops: BisonOps): Promise<BuildResult> {
  const { instance, name } = job;
  const working = `${BUILD_PREFIX}${name}`;
  const created = await ops.createCampaign(instance, working);
  if (created === "unsure") {
    return {
      state: "failed", name, campaignId: null, unsure: true,
      note: `Email Bison didn't answer when asked to make it, so it may have been made anyway as “${working}”. Look for it in Email Bison (delete it if it's there) before running again.`,
    };
  }
  if (!created) return { state: "failed", name, campaignId: null, note: "Email Bison didn't create the campaign — nothing was made." };
  const id = created.id;

  // Anything that goes wrong after this keeps the campaign aside under a name nobody can mistake.
  const park = async (why: string): Promise<BuildResult> => {
    const r = await ops.updateCampaign(instance, id, { name: `${CHECK_PREFIX}${name}` }).catch(() => ({ ok: false, status: 0 }));
    return {
      state: "failed", name, campaignId: id,
      note: `${why} It was kept as “${r.ok ? CHECK_PREFIX : BUILD_PREFIX}${name}” (#${id}) — look at it in Email Bison and delete it, then run again.`,
    };
  };

  try {
    // 1. Settings and limits.
    const settings = { name: working, ...job.limits, ...CAMPAIGN_SETTINGS };
    const s = await ops.updateCampaign(instance, id, settings);
    if (!s.ok) return park(`The settings weren't saved (${s.status}${s.message ? `: ${s.message}` : ""}).`);
    const d = await ops.getCampaign(instance, id);
    if (!d) return park("The settings couldn't be read back.");
    const wrong = (Object.keys(settings) as (keyof typeof settings)[]).filter((k) => k !== "name" && k in d && d[k] !== settings[k]);
    if (!(["max_emails_per_day", "max_new_leads_per_day", "plain_text", "open_tracking", "can_unsubscribe", "sequence_prioritization"] as const).every((k) => k in d)) {
      return park("The settings read back without some of their fields.");
    }
    if (wrong.length) return park(`Read back with different settings (${wrong.join(", ")}).`);

    // 2. The emails.
    const st = await ops.addSteps(instance, id, name, job.steps);
    if (!st.ok) return park(`The emails weren't saved (${st.status}${st.message ? `: ${st.message}` : ""}).`);
    const steps = await ops.getSteps(instance, id);
    if (!steps) return park("The emails couldn't be read back.");
    const bad = stepMismatches(job.steps, steps);
    if (bad.length) return park(`The emails read back different: ${bad.join("; ")}.`);

    // 3. The schedule (a new campaign has none, so it's created).
    const sc = await ops.createSchedule(instance, id, job.schedule);
    if (!sc.ok) return park(`The schedule wasn't saved (${sc.status}${sc.message ? `: ${sc.message}` : ""}).`);
    const back = await ops.getSchedule(instance, id);
    if (!back) return park("The schedule couldn't be read back.");
    const sched = job.schedule as unknown as Record<string, unknown>;
    const off = [
      ...DAYS.filter((day) => !!back[day] !== !!sched[day]),
      ...(hm(back.start_time) !== job.schedule.start_time ? ["start"] : []),
      ...(hm(back.end_time) !== job.schedule.end_time ? ["end"] : []),
      ...(String(back.timezone ?? "") !== job.schedule.timezone ? ["time zone"] : []),
    ];
    if (off.length) return park(`The schedule read back different (${off.join(", ")}).`);

    // 4. Tags — exactly these.
    const t = await ops.attachTags(instance, job.tags.map((x) => x.id), [id]);
    if (!t.ok) return park(`The tags weren't attached (${t.status}${t.message ? `: ${t.message}` : ""}).`);
    const tags = await ops.getTags(instance, id);
    if (!tags) return park("The tags couldn't be read back.");
    const want = job.tags.map((x) => x.id).sort((a, b) => a - b).join(",");
    const have = tags.map((x) => x.id).sort((a, b) => a - b).join(",");
    if (want !== have) return park(`The tags read back as ${tags.map((x) => x.name).join(", ") || "none"} instead of ${job.tags.map((x) => x.name).join(", ")}.`);

    // 5. Everything checked out — now it gets its real name.
    const n = await ops.updateCampaign(instance, id, { name });
    const after = n.ok ? await ops.getCampaign(instance, id) : null;
    if (!n.ok || String(after?.name ?? "") !== name) return park("It couldn't be given its real name.");
    return { state: "created", name, campaignId: id, note: "" };
  } catch (e) {
    return park(`Something went wrong part-way (${(e as Error).message}).`);
  }
}
