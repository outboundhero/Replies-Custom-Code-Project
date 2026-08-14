/**
 * DM4PM meeting tracker (§16/§17/§18). Reads the DM4PM meeting sheet (separate
 * from the OH meetings tracker — never mix, §27) and maps a lead's email to its
 * meeting outcome so the subsequence can pause/stop/route correctly.
 *
 * Sheet: 1QcEka3pGlV791KeMoVnSug6lxfcR5Xu2-xOyEXmCpxQ (shared read-only).
 * Three live tabs share the same signal columns; only the Email column shifts,
 * so columns are located by HEADER name, not a fixed letter:
 *   - Meeting Start Date  → a value = a booked meeting
 *   - Qualified           → YES / NO / …
 *   - Showed              → rich status (YES, NO, CANCELLED BY …, RESCHEDULED …, etc.)
 * The "DO NOT USE" tab is ignored.
 */
import { getAuth } from "@/lib/push-to-sheet";
import { google } from "googleapis";

const SHEET_ID = "1QcEka3pGlV791KeMoVnSug6lxfcR5Xu2-xOyEXmCpxQ";
const TABS = [
  "Grow.DM4PM.com Lead Form Signups",
  " OutBound Grow.DM4PM.com Lead Form Signups", // leading space is part of the real tab name
  "Nurture",
];

export interface MeetingInfo {
  matched: boolean;
  booked: boolean;        // Meeting Start Date present
  meetingDate: string | null;
  qualified: string;      // raw cell
  showed: string;         // raw cell
  tab: string | null;
}

const EMPTY: MeetingInfo = { matched: false, booked: false, meetingDate: null, qualified: "", showed: "", tab: null };

export type MeetingOutcome =
  | "none"              // no match / no meeting signal
  | "booked_pending"    // booked, not yet held → pause
  | "attended"          // showed / held / existing client → stop, don't resume
  | "qualified_no_show" // no-show + qualified → Re-Contact Queue
  | "no_show_drop"      // no-show + not qualified → drop
  | "canceled"          // cancelled by prospect/client → §18 (return to Open Responses)
  | "reschedule"        // rescheduled / postponed → stay paused, wait
  | "not_interested"    // passed / not interested / franchise → stop → nurture
  | "duplicate";        // duplicate → stop

// ── Sheet load (cached ~60s so per-lead checks don't refetch) ────────────────

interface Loaded { at: number; index: Map<string, MeetingInfo> }
let _cache: Loaded | null = null;
const TTL_MS = 60_000;

function headerIndex(header: string[]): { email: number; date: number; qualified: number; showed: number } {
  const norm = header.map((h) => String(h || "").trim().toLowerCase());
  return {
    email: norm.findIndex((h) => h === "email"),
    date: norm.findIndex((h) => h.includes("meeting start")),
    qualified: norm.findIndex((h) => h.startsWith("qualif")),
    showed: norm.findIndex((h) => h.startsWith("showed")),
  };
}

function dateValue(s: string | null): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/** Pick the more-relevant of two rows for the same email: a booked meeting wins;
 *  among booked, the latest date; among same date, a pending (blank Showed) row
 *  (an upcoming/replacement meeting) wins over a terminal one. */
function better(a: MeetingInfo, b: MeetingInfo): MeetingInfo {
  if (a.booked !== b.booked) return a.booked ? a : b;
  if (a.booked && b.booked) {
    const da = dateValue(a.meetingDate), db = dateValue(b.meetingDate);
    if (da !== db) return da > db ? a : b;
    const aPending = !a.showed.trim(), bPending = !b.showed.trim();
    if (aPending !== bPending) return aPending ? a : b;
  }
  return a;
}

async function loadIndex(force = false): Promise<Map<string, MeetingInfo>> {
  if (!force && _cache && Date.now() - _cache.at < TTL_MS) return _cache.index;
  const sheets = google.sheets({ version: "v4", auth: getAuth() });
  const index = new Map<string, MeetingInfo>();

  for (const tab of TABS) {
    let rows: string[][] = [];
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${tab}'!A1:L` });
      rows = (res.data.values as string[][]) || [];
    } catch { continue; } // a renamed/missing tab must not break the others
    if (rows.length < 2) continue;
    const col = headerIndex(rows[0]);
    if (col.email < 0) continue;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const email = String(row[col.email] ?? "").trim().toLowerCase();
      if (!email) continue;
      const meetingDate = col.date >= 0 ? String(row[col.date] ?? "").trim() : "";
      const info: MeetingInfo = {
        matched: true,
        booked: !!meetingDate,
        meetingDate: meetingDate || null,
        qualified: col.qualified >= 0 ? String(row[col.qualified] ?? "").trim() : "",
        showed: col.showed >= 0 ? String(row[col.showed] ?? "").trim() : "",
        tab,
      };
      const prev = index.get(email);
      index.set(email, prev ? better(prev, info) : info);
    }
  }
  _cache = { at: Date.now(), index };
  return index;
}

/** Look up a lead's meeting outcome by email (case-insensitive). */
export async function checkMeeting(email: string, force = false): Promise<MeetingInfo> {
  if (!email?.trim()) return EMPTY;
  const index = await loadIndex(force);
  return index.get(email.trim().toLowerCase()) ?? EMPTY;
}

/**
 * Map a MeetingInfo to the subsequence action. Showed is authoritative; a
 * blank/unknown Showed on a booked meeting is treated conservatively as
 * "booked, pending" (pause — never infer a no-show, §17).
 */
export function meetingOutcome(info: MeetingInfo): MeetingOutcome {
  if (!info.matched) return "none";
  const showed = info.showed.trim().toUpperCase();
  const qualifiedYes = info.qualified.trim().toUpperCase() === "YES";

  if (showed.includes("CANCEL")) return "canceled";              // CANCELLED BY PROSPECT/CLIENT
  if (showed.includes("RESCHEDUL") || showed.includes("POSTPON")) return "reschedule";
  if (showed.includes("DUPLICATE") || showed === "DUPE") return "duplicate";
  if (showed.includes("PASSED") || showed.includes("NOT INTERESTED") || showed.includes("FRANCHISE")) return "not_interested";
  if (showed === "YES" || showed.startsWith("HELD") || showed.startsWith("EXISTING CLIENT")) return "attended";
  if (showed === "NO") return qualifiedYes ? "qualified_no_show" : "no_show_drop";

  // Blank / unrecognized Showed:
  if (info.booked) return "booked_pending"; // a meeting exists but hasn't been resolved → pause
  return "none";
}
