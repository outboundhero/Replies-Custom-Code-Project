/**
 * Writes the "Lead handoff email" column in a client's Google leads sheet — the
 * ACTUAL email we sent to the lead (CC'ing the client's bosses), recorded ONLY
 * when Send Reply is clicked (never the template/draft).
 *
 * Row selection:
 *   Option B (exact): the row Google returned when we appended this lead (stored
 *     on the reply as sheet_row/sheet_id) — unambiguous, duplicate-email safe.
 *   Option A (fallback): match the lead's email in column A, newest row — for
 *     leads with no stored row (pre-feature) or a rebuilt sheet id.
 *   Neither → skip (lead was never pushed; no stray row is created).
 *
 * The column is located by header name ("Lead handoff email", case-insensitive)
 * and created at the next empty column (≥ X, past the positional A:W push range)
 * on sheets that don't have it yet.
 */
import { google, sheets_v4 } from "googleapis";
import { getAuth } from "@/lib/push-to-sheet";
import { getSheetForClient } from "@/lib/google-sheets-registry";

export const HANDOFF_HEADER = "Lead handoff email";

// pushToSheet appends data across A:W (23 columns) regardless of how many HEADER
// cells a sheet has filled — several client sheets have sparse header rows (only
// ~21-22 filled) while their data rows still occupy all 23. So a new column must
// be placed at index ≥ 23 (col X), never merely "after the last filled header",
// or we'd label/overwrite an existing data column.
const PUSH_COLUMN_COUNT = 23;

/** 0-based column index → A1 letter (0→A, 25→Z, 26→AA). */
export function colLetter(idx: number): string {
  let s = "";
  let n = idx;
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

/** Find the "Lead handoff email" column; create it at the next empty column when
 *  absent. Returns the 0-based column index. Idempotent. */
export async function ensureHandoffColumn(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
): Promise<number> {
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!1:1`,
  });
  const headers: string[] = (headerRes.data.values?.[0] || []).map((h) => String(h || ""));
  const existing = headers.findIndex((h) => h.trim().toLowerCase() === HANDOFF_HEADER.toLowerCase());
  if (existing !== -1) return existing;

  // Next empty column, but never inside the A:W data range (see PUSH_COLUMN_COUNT).
  const idx = Math.max(headers.length, PUSH_COLUMN_COUNT);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!${colLetter(idx)}1`,
    valueInputOption: "RAW",
    requestBody: { values: [[HANDOFF_HEADER]] },
  });
  return idx;
}

export async function setLeadHandoffEmail(
  clientTag: string,
  leadEmail: string,
  bodyText: string,
  opts?: { row?: number; sheetId?: string },
): Promise<{ ok: boolean; error?: string; skipped?: string }> {
  let sheet: { id: string; name: string } | null = null;
  try {
    const found = await getSheetForClient(clientTag);
    if (found) sheet = { id: found.id, name: found.sheetName };
  } catch (e) {
    return { ok: false, error: `Sheet registry fetch failed: ${(e as Error).message}` };
  }
  if (!sheet) return { ok: false, skipped: `no sheet registered for ${clientTag}` };

  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // Column — find or create by header name.
  let col: string;
  try {
    col = colLetter(await ensureHandoffColumn(sheets, sheet.id, sheet.name));
  } catch (e) {
    return { ok: false, error: `handoff column lookup failed: ${(e as Error).message}` };
  }

  // Row — Option B (exact appended row) first, else Option A (email match).
  let rowNum: number | null = null;
  if (opts?.row && opts.sheetId && opts.sheetId === sheet.id) {
    rowNum = opts.row;
  } else {
    try {
      const colA = await sheets.spreadsheets.values.get({
        spreadsheetId: sheet.id,
        range: `'${sheet.name}'!A:A`,
      });
      const emails: string[] = (colA.data.values || []).map((r) => String(r[0] || "").trim().toLowerCase());
      const target = leadEmail.trim().toLowerCase();
      for (let i = emails.length - 1; i >= 1; i--) { // newest first; skip header (i=0)
        if (emails[i] === target) { rowNum = i + 1; break; } // A1 rows are 1-based
      }
    } catch (e) {
      return { ok: false, error: `row lookup failed: ${(e as Error).message}` };
    }
  }
  if (!rowNum) return { ok: false, skipped: "no matching row in sheet" };

  // Update the cell, retrying transient Google API failures (mirror pushToSheet).
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheet.id,
        range: `'${sheet.name}'!${col}${rowNum}`,
        valueInputOption: "RAW",
        requestBody: { values: [[bodyText]] },
      });
      return { ok: true };
    } catch (error) {
      lastErr = (error as Error).message || "unknown error";
      const status = (error as { code?: number; response?: { status?: number } })?.code
        ?? (error as { response?: { status?: number } })?.response?.status;
      const transient = status === 429 || (typeof status === "number" && status >= 500)
        || /rate limit|quota|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up|network|fetch failed|backend error|internal error/i.test(lastErr);
      if (!transient || attempt === 3) break;
      await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 800, 6000)));
    }
  }
  return { ok: false, error: lastErr };
}
