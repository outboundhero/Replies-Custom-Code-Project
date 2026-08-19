/**
 * Emails a client's lead-tracking Google Sheet has marked as "Meeting-Ready Lead".
 *
 * The client sheet is the source of truth for what was DELIVERED to the client
 * as a meeting-ready (hot) lead — and it frequently disagrees with our stored
 * `lead_category` (operators/clients edit the sheet, and legacy leads aren't in
 * `replies` at all). Nurture must never re-target a lead the sheet marks
 * Meeting-Ready, so the auto-push gate consults this set.
 *
 * IMPORTANT: only the "Meeting-Ready Lead" category excludes. A lead merely
 * PRESENT in the sheet under another category (Interested / Follow Up / Referral
 * Given / …) is NOT blocked here — presence alone is not the signal.
 *
 * Cached in-process per client (10 min). A successful read is cached; a read
 * ERROR is not (so it retries), and the caller decides how to handle `ok=false`.
 */
import { google } from "googleapis";
import { getAuth } from "@/lib/push-to-sheet";
import { getSheetForClient } from "@/lib/google-sheets-registry";

export interface SheetMeetingReadyResult {
  /** false only when the client HAS a registered sheet we failed to read. */
  ok: boolean;
  /** true when the client has a sheet registered at all. */
  hasSheet: boolean;
  /** lowercased emails marked "Meeting-Ready Lead" in the sheet. */
  emails: Set<string>;
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { result: SheetMeetingReadyResult; ts: number }>();

/** Sheet category cell counts as Meeting-Ready ("Meeting-Ready Lead",
 *  "Meeting Ready Lead", trailing notes, etc.). */
function isMeetingReady(cat: string): boolean {
  return /meeting[\s-]?ready/i.test(cat);
}

export async function getSheetMeetingReadyEmails(clientTag: string): Promise<SheetMeetingReadyResult> {
  const key = (clientTag || "").toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.result;

  let found: Awaited<ReturnType<typeof getSheetForClient>>;
  try {
    found = await getSheetForClient(clientTag);
  } catch {
    // Registry lookup failed — treat as unreadable (caller fails closed).
    return { ok: false, hasSheet: true, emails: new Set() };
  }
  if (!found) {
    // No sheet registered → nothing to gate against; proceed normally.
    const result = { ok: true, hasSheet: false, emails: new Set<string>() };
    cache.set(key, { result, ts: Date.now() });
    return result;
  }

  try {
    const sheets = google.sheets({ version: "v4", auth: getAuth() });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: found.id,
      range: `'${found.sheetName}'!A1:Z`,
    });
    const rows = res.data.values || [];
    const headers = (rows[0] || []).map((h) => String(h ?? ""));
    const H = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const emailCol = headers.findIndex((h) => H(h) === "lead email");
    const catCol = headers.findIndex((h) => H(h).includes("lead category"));
    const emails = new Set<string>();
    if (emailCol >= 0 && catCol >= 0) {
      for (const row of rows.slice(1)) {
        const cat = String(row[catCol] ?? "").trim();
        const email = String(row[emailCol] ?? "").trim().toLowerCase();
        if (email && isMeetingReady(cat)) emails.add(email);
      }
    }
    const result = { ok: true, hasSheet: true, emails };
    cache.set(key, { result, ts: Date.now() });
    return result;
  } catch {
    // Transient Sheets error — do NOT cache; caller fails closed for this run.
    return { ok: false, hasSheet: true, emails: new Set() };
  }
}
