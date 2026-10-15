/**
 * The +4h nurture schedule rule, pure (no I/O) so onboarding's campaign
 * builder and the nurture cron (lib/nurture/nurture-schedule.ts) share it.
 */
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const OFFSET_HOURS = 4;
const MIN_WINDOW_MIN = 30; // never compress the nurture window below this

export interface NurtureSchedule {
  monday: boolean; tuesday: boolean; wednesday: boolean; thursday: boolean;
  friday: boolean; saturday: boolean; sunday: boolean;
  // Bison's POST /schedule requires "H:i" (HH:MM, NO seconds) and a
  // save_as_template flag — a payload with "HH:MM:SS" (what GET returns) 422s.
  start_time: string; end_time: string; timezone: string;
  save_as_template: boolean;
}

export function toSec(hhmmss: string): number {
  const [h = 0, m = 0, s = 0] = String(hhmmss || "").split(":").map(Number);
  return h * 3600 + m * 60 + s;
}
/** Seconds-of-day → "HH:MM" (Bison's required H:i format; no seconds). */
function secToHM(sec: number): string {
  const clamped = Math.max(0, Math.min(sec, 86399));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  return [h, m].map((n) => String(n).padStart(2, "0")).join(":");
}
/** Any "HH:MM[:SS]" → "HH:MM". */
function toHM(hhmmss: string): string {
  return secToHM(toSec(hhmmss));
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
    start_time: secToHM(newStart), // "HH:MM" — Bison rejects seconds
    end_time: toHM(endRaw),        // "HH:MM"
    timezone: String(main.timezone ?? "") || "America/Chicago",
    save_as_template: false,       // required by POST /schedule
  };
}
