/**
 * Business-day + US-federal-holiday scheduler for the DM4PM subsequence.
 *
 * All date math is anchored to **America/Los_Angeles** (Pacific) so that
 * "business day", "next two business days" (CTA copy), and step send-times are
 * computed against the wall clock DM4PM operates on — correct across PST/PDT.
 *
 * Nothing like this existed in the repo before; the only prior scheduling code
 * (`app/api/inbox/mutate/route.ts:260`) hardcodes `16:00 UTC` and is DST-naive.
 * This module computes the true Pacific offset per instant instead.
 *
 * Public API:
 *   - isBusinessDay(date)          → is this instant's Pacific date a business day
 *   - nextBusinessDay(from)        → send-time on the next business day after `from`
 *   - scheduleFrom(from, delay)    → next_step_due_at for a step (delay → roll → 9am PT)
 *   - ctaDays(sendAt)              → { day1, day2 } labels for {NEXT_BUSINESS_DAY_1/2}
 *   - STEP_CADENCE                 → the 7-step delay config (§8)
 */

const TZ = "America/Los_Angeles";
const WEEKDAY_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Wall-clock hour (Pacific) that scheduled steps send at. Time-of-day is not
 *  spec-critical (§9: "Days only; no specific times are required"); a fixed
 *  business-hours send is predictable and lands in the morning for the lead. */
export const SEND_HOUR_PT = 9;

/** A civil (calendar) date in Pacific, independent of time-of-day. */
interface Civil {
  y: number;
  m: number; // 1–12
  d: number;
}

export type StepDelay = { hours: number } | { days: number } | { businessDays: number };

/**
 * Step cadence (§8). Index 0 = Step 1's delay from activation; index i>0 =
 * Step (i+1)'s delay from the previous step's send time. Each result is rolled
 * forward to the next business day.
 */
export const STEP_CADENCE: StepDelay[] = [
  { hours: 25 },       // Step 1: 25 hours after activation
  { days: 2 },         // Step 2: 2 days later
  { days: 2 },         // Step 3
  { days: 2 },         // Step 4
  { days: 2 },         // Step 5
  { days: 2 },         // Step 6
  { businessDays: 5 }, // Step 7: 5 business days later
];

// ── Pacific wall-clock <-> instant ──────────────────────────────────────────

/** Break an instant into its Pacific civil parts (year..second). */
function pacificParts(date: Date): Civil & { hour: number; minute: number; second: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== "literal") map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // some ICU builds emit "24" for midnight
  return { y: Number(map.year), m: Number(map.month), d: Number(map.day), hour, minute: Number(map.minute), second: Number(map.second) };
}

/** Pacific UTC offset (minutes, negative) at a given instant. */
function pacificOffsetMinutes(date: Date): number {
  const p = pacificParts(date);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, p.second);
  return (asUtc - date.getTime()) / 60000;
}

/** Convert a Pacific wall-clock (civil date + h:m) to the matching UTC instant. */
function civilToInstant(c: Civil, hour: number, minute: number): Date {
  const naive = Date.UTC(c.y, c.m - 1, c.d, hour, minute, 0);
  // First pass with the offset at the naive guess, then re-check once to settle
  // across a DST boundary (the offset can differ between guess and result).
  const off1 = pacificOffsetMinutes(new Date(naive));
  let utc = naive - off1 * 60000;
  const off2 = pacificOffsetMinutes(new Date(utc));
  if (off2 !== off1) utc = naive - off2 * 60000;
  return new Date(utc);
}

// ── Civil-date arithmetic (calendar-only, via a UTC marker) ─────────────────

function marker(c: Civil): Date { return new Date(Date.UTC(c.y, c.m - 1, c.d)); }
function civilOf(mk: Date): Civil { return { y: mk.getUTCFullYear(), m: mk.getUTCMonth() + 1, d: mk.getUTCDate() }; }
function addCalendarDays(c: Civil, n: number): Civil { const mk = marker(c); mk.setUTCDate(mk.getUTCDate() + n); return civilOf(mk); }
/** Day of week for a civil date: 0=Sun … 6=Sat. */
function dow(c: Civil): number { return marker(c).getUTCDay(); }
function sameCivil(a: Civil, b: Civil): boolean { return a.y === b.y && a.m === b.m && a.d === b.d; }

// ── US federal holidays (observed) ──────────────────────────────────────────

/** The nth (1-based) occurrence of `weekday` (0=Sun..6=Sat) in a month. */
function nthWeekday(y: number, month: number, weekday: number, n: number): Civil {
  const firstDow = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
  const day = 1 + ((7 + weekday - firstDow) % 7) + (n - 1) * 7;
  return { y, m: month, d: day };
}

/** The last occurrence of `weekday` in a month. */
function lastWeekday(y: number, month: number, weekday: number): Civil {
  const lastDay = new Date(Date.UTC(y, month, 0)).getUTCDate(); // day 0 of next month
  const lastDow = new Date(Date.UTC(y, month - 1, lastDay)).getUTCDay();
  const day = lastDay - ((7 + lastDow - weekday) % 7);
  return { y, m: month, d: day };
}

/** Observed shift for a fixed-date holiday: Sat → prior Fri, Sun → next Mon. */
function observed(c: Civil): Civil {
  const w = dow(c);
  if (w === 6) return addCalendarDays(c, -1);
  if (w === 0) return addCalendarDays(c, 1);
  return c;
}

function keyOf(c: Civil): string { return `${c.y}-${c.m}-${c.d}`; }

const _holidayCache = new Map<number, Set<string>>();

/** Observed federal-holiday date-keys for a given year. */
function holidaysForYear(y: number): Set<string> {
  const cached = _holidayCache.get(y);
  if (cached) return cached;
  const set = new Set<string>();
  // Fixed-date (observed): New Year's, Juneteenth, Independence, Veterans, Christmas.
  for (const [m, d] of [[1, 1], [6, 19], [7, 4], [11, 11], [12, 25]] as const) {
    set.add(keyOf(observed({ y, m, d })));
  }
  // Floating (always land on their weekday — no observation shift).
  set.add(keyOf(nthWeekday(y, 1, 1, 3)));   // MLK — 3rd Monday of January
  set.add(keyOf(nthWeekday(y, 2, 1, 3)));   // Washington's Birthday — 3rd Monday of February
  set.add(keyOf(lastWeekday(y, 5, 1)));     // Memorial Day — last Monday of May
  set.add(keyOf(nthWeekday(y, 9, 1, 1)));   // Labor Day — 1st Monday of September
  set.add(keyOf(nthWeekday(y, 10, 1, 2)));  // Columbus Day — 2nd Monday of October
  set.add(keyOf(nthWeekday(y, 11, 4, 4)));  // Thanksgiving — 4th Thursday of November
  _holidayCache.set(y, set);
  return set;
}

/** Is a civil date a federal holiday? Checks adjacent years too, so a New
 *  Year's Day observed on Dec 31 of the prior year is caught. */
function isHoliday(c: Civil): boolean {
  const k = keyOf(c);
  return holidaysForYear(c.y).has(k) || holidaysForYear(c.y - 1).has(k) || holidaysForYear(c.y + 1).has(k);
}

function isBusinessCivil(c: Civil): boolean {
  const w = dow(c);
  return w !== 0 && w !== 6 && !isHoliday(c);
}

/** Roll a civil date forward (in place of itself) to the next business day. */
function rollToBusiness(c: Civil): Civil {
  let cur = c;
  while (!isBusinessCivil(cur)) cur = addCalendarDays(cur, 1);
  return cur;
}

/** The first business day strictly after `c`. */
function nextBusinessCivil(c: Civil): Civil {
  let cur = addCalendarDays(c, 1);
  while (!isBusinessCivil(cur)) cur = addCalendarDays(cur, 1);
  return cur;
}

function addBusinessDays(c: Civil, n: number): Civil {
  let cur = c;
  for (let i = 0; i < n; i++) cur = nextBusinessCivil(cur);
  return cur;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Is the Pacific calendar date of `date` a business day (Mon–Fri, non-holiday)? */
export function isBusinessDay(date: Date): boolean {
  return isBusinessCivil(pacificParts(date));
}

/** Send-time (9am PT) on the first business day after `from`'s Pacific date. */
export function nextBusinessDay(from: Date): Date {
  const c = nextBusinessCivil(pacificParts(from));
  return civilToInstant(c, SEND_HOUR_PT, 0);
}

/**
 * Compute a step's `next_step_due_at`: apply the delay, roll the resulting
 * Pacific date to a business day, and pin it to the send hour (9am PT).
 *  - {hours}: added to the `from` instant, then that Pacific date is used.
 *  - {days}: calendar days added to `from`'s Pacific date.
 *  - {businessDays}: business days added to `from`'s Pacific date.
 */
export function scheduleFrom(from: Date, delay: StepDelay): Date {
  const base = pacificParts(from);
  let target: Civil;
  if ("hours" in delay) {
    target = pacificParts(new Date(from.getTime() + delay.hours * 3_600_000));
  } else if ("days" in delay) {
    target = addCalendarDays(base, delay.days);
  } else {
    target = addBusinessDays(base, delay.businessDays);
  }
  target = rollToBusiness(target);
  return civilToInstant(target, SEND_HOUR_PT, 0);
}

/**
 * The two CTA business-day labels for {NEXT_BUSINESS_DAY_1/2}, relative to the
 * day the email actually sends (§9). "tomorrow" only when literally the next
 * calendar day; otherwise the weekday name. Computed at send time by the caller.
 */
export function ctaDays(sendAt: Date): { day1: string; day2: string } {
  const send = pacificParts(sendAt);
  const d1 = nextBusinessCivil(send);
  const d2 = nextBusinessCivil(d1);
  return { day1: labelFor(d1, send), day2: labelFor(d2, send) };
}

function labelFor(target: Civil, reference: Civil): string {
  if (sameCivil(target, addCalendarDays(reference, 1))) return "tomorrow";
  return WEEKDAY_NAME[dow(target)];
}
