/**
 * Push a qualified lead to the client's Google Sheet.
 * Called when lead is marked as: Interested, Meeting Ready Lead, Follow Up,
 * Referral Given, or Internally Forwarded.
 */

import { google } from "googleapis";
import { getSheetForClient } from "@/lib/google-sheets-registry";

export function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

/** Categories that trigger auto-push to Google Sheet */
export const SHEET_PUSH_CATEGORIES = [
  "Interested",
  "Meeting Ready Lead",
  "Meeting-Ready Lead",
  "Follow Up",
  "Referral Given",
  "Internally Forwarded",
];

interface ReplyData {
  lead_email: string;
  lead_name: string;
  company_name: string;
  reply_time: string;
  city: string;
  state: string;
  address: string;
  google_maps_url: string;
  phone: string;
  lead_category: string;
  client_tag: string;
  sender_email: string;
  reply_we_got: string;
  prospect_cc_email: string;
  our_reply: string;
  cc_email_1: string;
  cc_email_2: string;
  cc_email_3: string;
  bcc_email_1: string;
  notes: string;
}

/**
 * True if a row with this lead email already exists in the client's sheet
 * (column A). Used to avoid duplicate rows when re-pushing a lead — e.g. when a
 * reallocated lead is added to the NEW client's sheet. On any read failure it
 * returns false (don't block the push).
 */
export async function leadEmailInSheet(clientTag: string, leadEmail: string): Promise<boolean> {
  const email = (leadEmail || "").trim().toLowerCase();
  if (!email) return false;
  const found = await getSheetForClient(clientTag);
  if (!found) return false;
  try {
    const sheets = google.sheets({ version: "v4", auth: getAuth() });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: found.id,
      range: `'${found.sheetName}'!A:A`,
    });
    return (res.data.values || []).some((r) => String(r[0] || "").trim().toLowerCase() === email);
  } catch {
    return false;
  }
}

export async function pushToSheet(
  clientTag: string,
  data: ReplyData,
  override?: { spreadsheetId: string; tabName: string } | null,
): Promise<{ ok: boolean; error?: string; row?: number; sheetId?: string }> {
  // A per-lead sheet override (set from the inbox) wins over the registry — the
  // operator explicitly pointed THIS lead at a specific sheet/tab.
  let sheet: { sheet_id: string; sheet_name: string } | null = override
    ? { sheet_id: override.spreadsheetId, sheet_name: override.tabName }
    : null;
  if (!sheet) {
    try {
      const found = await getSheetForClient(clientTag);
      if (found) sheet = { sheet_id: found.id, sheet_name: found.sheetName };
    } catch (err) {
      return { ok: false, error: `Sheet registry fetch failed: ${(err as Error).message}` };
    }
  }

  if (!sheet) {
    return { ok: false, error: `No Google Sheet registered for client ${clientTag}. Add it in the tracked-sheets dashboard first.` };
  }

  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const email = (data.lead_email || "").trim().toLowerCase();

  // Read the sheet's email column (A). Used for BOTH the idempotency check below
  // and the post-write verification — so a re-push/retry never duplicates and a
  // silent no-op is caught instead of being reported as a false success.
  const readEmailsColA = async (): Promise<Set<string>> => {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheet.sheet_id,
      range: `'${sheet.sheet_name}'!A:A`,
    });
    return new Set((res.data.values || []).map((r) => String(r[0] || "").trim().toLowerCase()).filter(Boolean));
  };

  // Idempotent: if this lead is already in the sheet, don't append a duplicate
  // (makes retries + re-pushes safe). On a read failure, fall through to append.
  if (email) {
    try {
      if ((await readEmailsColA()).has(email)) return { ok: true, sheetId: sheet.sheet_id };
    } catch { /* read failed → proceed to append */ }
  }

  // Map data to sheet columns (matching the column order from ABM sheet)
  const row = [
    data.lead_email || "",
    data.lead_name || "",
    data.company_name || "",
    new Date().toISOString(), // Time We Got Reply
    data.reply_time || "",
    data.city || "",
    data.state || "",
    data.address || "",
    data.google_maps_url || "",
    data.phone || "",
    data.lead_category || "",
    data.client_tag || "",
    data.sender_email || "",
    data.reply_we_got || "",
    data.prospect_cc_email || "",
    data.our_reply || "",
    data.cc_email_1 || "",
    data.cc_email_2 || "",
    data.cc_email_3 || "",
    data.bcc_email_1 || "",
    "", // Duplicate Check
    "New", // Status (Required)
    data.notes || "", // Notes (Required)
  ];

  // Retry transient Google API failures (rate limit / 5xx / network) a few
  // times before giving up, so a blip never drops a lead. Permanent errors
  // (bad range, permission) fail fast.
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await sheets.spreadsheets.values.append({
        spreadsheetId: sheet.sheet_id,
        range: `'${sheet.sheet_name}'!A:W`,
        valueInputOption: "USER_ENTERED",
        // INSERT_ROWS (not the default OVERWRITE): always INSERT a fresh row for
        // the lead. The default overwrote the last row when the sheet's grid had
        // no spare rows — so multiple leads all landed on the same row number,
        // each silently clobbering the previous, while Google still reported
        // "success". This was the root cause of "pushed to sheet" but missing.
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [row] },
      });
      // Google returns the range it wrote, e.g. 'Sheet1'!A45:W45 → row 45. We
      // capture it so the send-reply flow can update THIS exact row later.
      const updatedRange = resp.data.updates?.updatedRange || "";
      const rowNum = updatedRange.match(/![A-Z]+(\d+)/i)?.[1];

      // VERIFY the write actually persisted. append can silently no-op / overwrite
      // on some grid layouts and still return a range — so confirm the lead email
      // is really present now. If not, fail LOUD (recorded + retryable) instead of
      // reporting a false success. A verify-read error doesn't block (trust append).
      if (email) {
        let present: boolean | null = null;
        try { present = (await readEmailsColA()).has(email); } catch { present = null; }
        if (present === false) {
          return { ok: false, error: `Sheet write did not persist — append reported "${updatedRange || "ok"}" but ${email} is not in '${sheet.sheet_name}' afterward (client ${clientTag}).` };
        }
      }
      return { ok: true, row: rowNum ? Number(rowNum) : undefined, sheetId: sheet.sheet_id };
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
