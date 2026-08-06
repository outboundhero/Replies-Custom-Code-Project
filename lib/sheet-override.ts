/**
 * Per-lead Google Sheet override.
 *
 * From the inbox, an operator can point a SINGLE lead at a specific Google Sheet
 * (paste its URL) — used when the client-tag → sheet registry is wrong/missing, or
 * to route one lead to a different tracking sheet. When that lead is later pushed
 * (categorized into a push category), the push targets this sheet instead of the
 * client's registered one. Stored in Turso (no Supabase migration needed).
 *
 * Set-time we resolve the URL to {spreadsheetId, tabName} and VERIFY the service
 * account can actually open it — so a bad link / un-shared sheet fails loudly in
 * the UI rather than silently at push time.
 */
import { google } from "googleapis";
import db from "@/lib/db";
import { getAuth } from "@/lib/push-to-sheet";

export interface SheetOverride { spreadsheetId: string; tabName: string; url: string }

/** Extract the spreadsheet id + optional gid (tab) from a Google Sheets URL. */
export function parseSheetUrl(url: string): { spreadsheetId: string; gid: string | null } | null {
  const idMatch = String(url || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!idMatch) return null;
  const gidMatch = String(url).match(/[#&?]gid=(\d+)/);
  return { spreadsheetId: idMatch[1], gid: gidMatch ? gidMatch[1] : null };
}

/** Resolve the tab NAME for a gid (or the first visible tab). Throws if the sheet
 *  can't be opened by the service account — surfaced to the operator on save. */
async function resolveTabName(spreadsheetId: string, gid: string | null): Promise<string> {
  const sheets = google.sheets({ version: "v4", auth: getAuth() });
  let meta;
  try {
    meta = await sheets.spreadsheets.get({ spreadsheetId });
  } catch (e) {
    throw new Error(`Can't open that sheet — make sure it's shared with the service account (${(e as Error).message}).`);
  }
  const tabs = meta.data.sheets || [];
  if (gid != null) {
    const t = tabs.find((s) => String(s.properties?.sheetId) === String(gid));
    if (t?.properties?.title) return t.properties.title;
  }
  const firstVisible = tabs.find((s) => !s.properties?.hidden) || tabs[0];
  if (!firstVisible?.properties?.title) throw new Error("That sheet has no readable tabs.");
  return firstVisible.properties.title;
}

async function ensureTable(): Promise<void> {
  await db.execute(`CREATE TABLE IF NOT EXISTS reply_sheet_override (
    reply_id INTEGER PRIMARY KEY,
    spreadsheet_id TEXT NOT NULL,
    tab_name TEXT NOT NULL,
    sheet_url TEXT,
    updated_at TEXT
  )`);
}

/** Validate + persist a per-lead override from a pasted URL. Throws on bad URL /
 *  inaccessible sheet (message is safe to show the operator). */
export async function setReplySheetOverride(replyId: number, url: string): Promise<SheetOverride> {
  const parsed = parseSheetUrl(url);
  if (!parsed) throw new Error("That doesn't look like a Google Sheets link.");
  const tabName = await resolveTabName(parsed.spreadsheetId, parsed.gid);
  await ensureTable();
  await db.execute({
    sql: `INSERT INTO reply_sheet_override (reply_id, spreadsheet_id, tab_name, sheet_url, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(reply_id) DO UPDATE SET
            spreadsheet_id = excluded.spreadsheet_id,
            tab_name = excluded.tab_name,
            sheet_url = excluded.sheet_url,
            updated_at = excluded.updated_at`,
    args: [replyId, parsed.spreadsheetId, tabName, String(url).trim(), new Date().toISOString()],
  });
  return { spreadsheetId: parsed.spreadsheetId, tabName, url: String(url).trim() };
}

export async function getReplySheetOverride(replyId: number): Promise<SheetOverride | null> {
  try {
    await ensureTable();
    const r = await db.execute({
      sql: "SELECT spreadsheet_id, tab_name, sheet_url FROM reply_sheet_override WHERE reply_id = ?",
      args: [replyId],
    });
    const row = r.rows[0];
    if (!row) return null;
    return { spreadsheetId: String(row.spreadsheet_id), tabName: String(row.tab_name), url: String(row.sheet_url ?? "") };
  } catch {
    return null;
  }
}

export async function clearReplySheetOverride(replyId: number): Promise<void> {
  try {
    await ensureTable();
    await db.execute({ sql: "DELETE FROM reply_sheet_override WHERE reply_id = ?", args: [replyId] });
  } catch { /* best-effort */ }
}
