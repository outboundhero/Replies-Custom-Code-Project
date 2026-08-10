/**
 * +4h nurture start offset.
 *
 * Nurture campaigns share sender inboxes with the client's MAIN campaigns. To
 * give mains first crack at the day's send capacity, every nurture campaign's
 * daily START time is set to its matching main campaign's start + 4 hours,
 * while KEEPING the main's end time (so nurture stays inside the client's
 * existing window and just takes the back half of the day). Days + timezone are
 * copied from the main schedule.
 *
 * Bison schedule shape (confirmed live):
 *   { monday..sunday: bool, start_time: "HH:MM:SS", end_time: "HH:MM:SS",
 *     timezone: "America/…" }  (GET/POST /api/campaigns/{id}/schedule)
 */
import { getCampaignSchedule, createCampaignSchedule } from "@/lib/outboundhero-api";
import { listNurtureCampaigns, listMainCampaigns, type InstanceCampaign } from "@/lib/nurture/campaign-inventory";
import { detectCampaignEsp } from "@/lib/nurture/esp";
import type { BisonInstanceKey } from "@/lib/bison-instances-shared";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const OFFSET_HOURS = 4;
const MIN_WINDOW_MIN = 30; // never compress the nurture window below this

export interface NurtureSchedule {
  monday: boolean; tuesday: boolean; wednesday: boolean; thursday: boolean;
  friday: boolean; saturday: boolean; sunday: boolean;
  start_time: string; end_time: string; timezone: string;
}

function toSec(hhmmss: string): number {
  const [h = 0, m = 0, s = 0] = String(hhmmss || "").split(":").map(Number);
  return h * 3600 + m * 60 + s;
}
function toHHMMSS(sec: number): string {
  const clamped = Math.max(0, Math.min(sec, 86399));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * Build the offset nurture schedule from a MAIN schedule: start +4h, keep the
 * main end/days/timezone. If +4h would leave less than MIN_WINDOW_MIN before the
 * end (or wrap past it), clamp the start to end − MIN_WINDOW_MIN (never earlier
 * than the main start). Returns null if the main schedule is unusable.
 */
export function shiftSchedule(main: Record<string, unknown> | null): NurtureSchedule | null {
  if (!main) return null;
  const startRaw = String(main.start_time ?? "");
  const endRaw = String(main.end_time ?? "");
  if (!startRaw || !endRaw) return null;

  const startSec = toSec(startRaw);
  const endSec = toSec(endRaw);
  let newStart = startSec + OFFSET_HOURS * 3600;
  const maxStart = endSec - MIN_WINDOW_MIN * 60;
  if (newStart > maxStart) newStart = Math.max(startSec, maxStart);

  const days = Object.fromEntries(DAYS.map((d) => [d, main[d] === true])) as Record<(typeof DAYS)[number], boolean>;
  return {
    ...days,
    start_time: toHHMMSS(newStart),
    end_time: endRaw,
    timezone: String(main.timezone ?? "") || "America/Chicago",
  };
}

export interface OffsetResult {
  tag: string;
  applied: Array<{ instance: string; campaignId: number; name: string; from: string; to: string; end: string }>;
  skipped: Array<{ instance: string; campaignId: number; name: string; reason: string }>;
}

/**
 * Apply the +4h offset to every nurture campaign for a client tag. Each nurture
 * campaign is matched to a MAIN campaign (same instance + same ESP; fallback =
 * the earliest-starting non-draft main on that instance) and takes that main's
 * shifted schedule. `dryRun` computes from/to without writing.
 */
export async function applyOffsetForClient(tag: string, opts?: { dryRun?: boolean }): Promise<OffsetResult> {
  const TAG = tag.toUpperCase();
  const dry = !!opts?.dryRun;
  const out: OffsetResult = { tag: TAG, applied: [], skipped: [] };

  const [nurts, mains] = await Promise.all([listNurtureCampaigns(TAG), listMainCampaigns(TAG)]);
  if (nurts.length === 0) return out;

  // Cache main schedules by campaign so repeated lookups don't re-hit Bison.
  const schedCache = new Map<string, Record<string, unknown> | null>();
  const schedOf = async (instance: BisonInstanceKey, id: number) => {
    const key = `${instance}:${id}`;
    if (!schedCache.has(key)) schedCache.set(key, await getCampaignSchedule(instance, id));
    return schedCache.get(key) ?? null;
  };
  const allNonDraftMains = mains.filter((m) => String(m.status).toLowerCase() !== "draft");
  // Earliest-starting main from a list (by schedule start_time).
  const earliest = async (list: InstanceCampaign[]): Promise<InstanceCampaign | undefined> => {
    let best: { m: InstanceCampaign; startSec: number } | null = null;
    for (const m of list) {
      const sc = await schedOf(m.instance, m.id);
      if (!sc?.start_time) continue;
      const startSec = toSec(String(sc.start_time));
      if (!best || startSec < best.startSec) best = { m, startSec };
    }
    return best?.m;
  };

  for (const n of nurts) {
    // Match to the CLIENT's main start — nurture and mains may live on different
    // instances, so fall back across instances rather than skipping.
    // 1) same instance + same ESP
    let main: InstanceCampaign | undefined =
      n.esp != null
        ? allNonDraftMains.find((m) => m.instance === n.instance && detectCampaignEsp(m.name) === n.esp)
        : undefined;
    // 2) any instance + same ESP (earliest-starting)
    if (!main && n.esp != null) {
      main = await earliest(allNonDraftMains.filter((m) => detectCampaignEsp(m.name) === n.esp));
    }
    // 3) earliest-starting non-draft main anywhere for this client
    if (!main) main = await earliest(allNonDraftMains);
    if (!main) {
      out.skipped.push({ instance: n.instance, campaignId: n.id, name: n.name, reason: "no matching main campaign" });
      continue;
    }

    const mainSched = await schedOf(main.instance, main.id);
    const shifted = shiftSchedule(mainSched);
    if (!shifted) {
      out.skipped.push({ instance: n.instance, campaignId: n.id, name: n.name, reason: "main has no usable schedule" });
      continue;
    }

    if (!dry) {
      const ok = await createCampaignSchedule(n.instance, n.id, shifted as unknown as Record<string, unknown>);
      if (!ok) {
        out.skipped.push({ instance: n.instance, campaignId: n.id, name: n.name, reason: "createCampaignSchedule failed" });
        continue;
      }
    }
    out.applied.push({
      instance: n.instance,
      campaignId: n.id,
      name: n.name,
      from: String(mainSched?.start_time ?? "?"),
      to: shifted.start_time,
      end: shifted.end_time,
    });
  }
  return out;
}

/**
 * Set the offset schedule on a SINGLE freshly-created nurture clone, given its
 * matching main schedule (used by the expansion cron). Returns whether it wrote.
 */
export async function applyOffsetToClone(
  instance: BisonInstanceKey,
  cloneId: number,
  mainSchedule: Record<string, unknown> | null,
): Promise<boolean> {
  const shifted = shiftSchedule(mainSchedule);
  if (!shifted) return false;
  return createCampaignSchedule(instance, cloneId, shifted as unknown as Record<string, unknown>);
}
