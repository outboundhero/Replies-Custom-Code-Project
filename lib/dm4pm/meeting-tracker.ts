/**
 * Interested-reply subsequence meeting tracker (§16/§17/§18), per client tag.
 *
 * Reads the client's meeting sheet (from lib/subsequence/config.ts) and maps a
 * lead's email → meeting outcome. Columns are located by HEADER name (robust to
 * column shifts). `outcomePolarity` handles the "Showed" (DM4PM) vs "No-Show"
 * (OH) difference. A client with no meeting sheet configured (e.g. OH before its
 * sheet is shared) returns "no match" so sends proceed un-gated.
 *
 * §26: never mix — each lead only reads ITS OWN client's sheet.
 */
import { getAuth } from "@/lib/push-to-sheet";
import { google } from "googleapis";
import { getSubsequenceConfig, type MeetingSheetConfig } from "@/lib/subsequence/config";

export interface MeetingInfo {
  matched: boolean;
  booked: boolean;        // Meeting Start Date present
  meetingDate: string | null;
  qualified: string;      // raw cell
  showed: string;         // raw cell — normalized to "showed" polarity (YES=attended)
  tab: string | null;
}

const EMPTY: MeetingInfo = { matched: false, booked: false, meetingDate: null, qualified: "", showed: "", tab: null };

export type MeetingOutcome =
  | "none"
  | "booked_pending"
  | "attended"
  | "qualified_no_show"
  | "no_show_drop"
  | "canceled"
  | "reschedule"
  | "not_interested"
  | "duplicate";

// ── Sheet load (cached ~60s per sheet) ───────────────────────────────────────

interface Loaded { at: number; index: Map<string, MeetingInfo> }
const _cache = new Map<string, Loaded>();
const TTL_MS = 60_000;

function headerIndex(header: string[], cols: MeetingSheetConfig["cols"]): { email: number; date: number; qualified: number; outcome: number } {
  const norm = header.map((h) => String(h || "").trim().toLowerCase());
  return {
    email: norm.findIndex((h) => h === cols.email),
    date: norm.findIndex((h) => h.includes(cols.date)),
    qualified: norm.findIndex((h) => h.startsWith(cols.qualified)),
    outcome: norm.findIndex((h) => h.startsWith(cols.outcome) || h.includes(cols.outcome)),
  };
}

function dateValue(s: string | null): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

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

/** Convert a raw "No-Show" cell to the shared "showed" polarity so downstream
 *  logic is identical: No-Show YES → "NO" (didn't attend), No-Show NO →
 *  "YES" (attended), blank → blank (unknown, never inferred). Non-yes/no values
 *  (e.g. "CANCELLED") pass through unchanged. */
function noShowToShowed(raw: string): string {
  const v = raw.trim().toUpperCase();
  if (v === "YES") return "NO";
  if (v === "NO") return "YES";
  return raw; // blank or a status word (canceled/rescheduled/…) → keep as-is
}

async function loadIndex(meeting: MeetingSheetConfig, force = false): Promise<Map<string, MeetingInfo>> {
  const cached = _cache.get(meeting.sheetId);
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.index;
  const sheets = google.sheets({ version: "v4", auth: getAuth() });
  const index = new Map<string, MeetingInfo>();

  for (const tab of meeting.tabs) {
    let rows: string[][] = [];
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: meeting.sheetId, range: `'${tab}'!A1:Z` });
      rows = (res.data.values as string[][]) || [];
    } catch { continue; }
    if (rows.length < 2) continue;
    const col = headerIndex(rows[0], meeting.cols);
    if (col.email < 0) continue;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const email = String(row[col.email] ?? "").trim().toLowerCase();
      if (!email) continue;
      const meetingDate = col.date >= 0 ? String(row[col.date] ?? "").trim() : "";
      const rawOutcome = col.outcome >= 0 ? String(row[col.outcome] ?? "").trim() : "";
      const info: MeetingInfo = {
        matched: true,
        booked: !!meetingDate,
        meetingDate: meetingDate || null,
        qualified: col.qualified >= 0 ? String(row[col.qualified] ?? "").trim() : "",
        showed: meeting.outcomePolarity === "noshow" ? noShowToShowed(rawOutcome) : rawOutcome,
        tab,
      };
      const prev = index.get(email);
      index.set(email, prev ? better(prev, info) : info);
    }
  }
  _cache.set(meeting.sheetId, { at: Date.now(), index });
  return index;
}

/** Look up a lead's meeting outcome by email for a client tag. Returns EMPTY
 *  when the client has no meeting sheet configured. */
export async function checkMeeting(tag: string, email: string, force = false): Promise<MeetingInfo> {
  if (!email?.trim()) return EMPTY;
  const cfg = getSubsequenceConfig(tag);
  if (!cfg?.meeting) return EMPTY; // no sheet wired → skip meeting gating
  const index = await loadIndex(cfg.meeting, force);
  return index.get(email.trim().toLowerCase()) ?? EMPTY;
}

/** Map a MeetingInfo (normalized to "showed" polarity) to a subsequence action.
 *  Showed is authoritative; a blank/unknown Showed on a booked meeting is
 *  treated conservatively as "booked, pending" (pause — never infer, §17). */
export function meetingOutcome(info: MeetingInfo): MeetingOutcome {
  if (!info.matched) return "none";
  const showed = info.showed.trim().toUpperCase();
  const qualifiedYes = info.qualified.trim().toUpperCase() === "YES";

  if (showed.includes("CANCEL")) return "canceled";
  if (showed.includes("RESCHEDUL") || showed.includes("POSTPON")) return "reschedule";
  if (showed.includes("DUPLICATE") || showed === "DUPE") return "duplicate";
  if (showed.includes("NOT A LEAD")) return "no_show_drop"; // OH — not a real lead, stop, no re-contact
  if (showed.includes("PASSED") || showed.includes("NOT INTERESTED") || showed.includes("FRANCHISE")) return "not_interested";
  if (showed === "YES" || showed.startsWith("HELD") || showed.startsWith("EXISTING CLIENT")) return "attended";
  if (showed === "NO") return qualifiedYes ? "qualified_no_show" : "no_show_drop";

  if (info.booked) return "booked_pending";
  return "none";
}
