/**
 * Push a qualified lead to the client's Google Sheet.
 * Called when lead is marked as: Interested, Meeting Ready Lead, or Follow Up.
 * (Referral Given / Internally Forwarded no longer auto-push — per client request
 * 2026-08-18 — but the manual "Push to sheet" action still works for any lead.)
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

  // Map each value to its column BY HEADER NAME, not by fixed position. Client
  // sheets differ — some omit the "Our last reply" column, add Zip/Zoho columns,
  // reorder, etc. — so a positional row silently lands values in the wrong
  // columns (our reply text in a CC column, "New" in Notes). Reading the header
  // row and matching by name makes it correct for every layout.
  const H = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const valueByHeader: Record<string, string> = {
    "lead email": data.lead_email || "",
    "lead name": data.lead_name || "",
    "company name": data.company_name || "",
    "time we got reply": new Date().toISOString(),
    "reply time": data.reply_time || "",
    "city": data.city || "",
    "state": data.state || "",
    "address": data.address || "",
    "google maps url": data.google_maps_url || "",
    "phone": data.phone || "",
    "current lead category": data.lead_category || "",
    "lead category": data.lead_category || "",
    "client tag": data.client_tag || "",
    "sender email": data.sender_email || "",
    "reply we got": data.reply_we_got || "",
    "prospect cc email": data.prospect_cc_email || "",
    "cc email 1": data.cc_email_1 || "",
    "cc email 2": data.cc_email_2 || "",
    "cc email 3": data.cc_email_3 || "",
    "bcc email 1": data.bcc_email_1 || "",
  };
  // Columns we intentionally NEVER fill — left blank for the client to own:
  //  · "Our last reply" / "Lead handoff email" — the handoff-email feature was
  //    removed (do NOT write our reply text into client sheets).
  //  · "Status (Required)" / "Notes (Required)" — client-filled (writing "New"
  //    put an invalid value into their validated dropdown).
  //  · "Duplicate Check", "# Of Attempts…", "Quality Lead Criteria…", etc.

  const colLetter = (n: number): string => {
    let s = "";
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };

  // Read the header row and build the row in the sheet's own column order.
  let headers: string[];
  try {
    const hres = await sheets.spreadsheets.values.get({
      spreadsheetId: sheet.sheet_id,
      range: `'${sheet.sheet_name}'!1:1`,
    });
    headers = (hres.data.values?.[0] || []).map((h) => String(h ?? ""));
  } catch (err) {
    return { ok: false, error: `Could not read header row for ${clientTag}'s sheet: ${(err as Error).message}` };
  }
  if (!headers.some((h) => H(h) === "lead email")) {
    // No recognizable layout — refuse rather than write a misaligned/blank row.
    return { ok: false, error: `Sheet for ${clientTag} has no "Lead Email" header (found: ${headers.slice(0, 8).map((h) => `"${h}"`).join(", ")}) — refusing to write a misaligned row.` };
  }
  const row = headers.map((h) => valueByHeader[H(h)] ?? "");
  const lastCol = colLetter(Math.max(headers.length, 1));

  // Retry transient Google API failures (rate limit / 5xx / network) a few
  // times before giving up, so a blip never drops a lead. Permanent errors
  // (bad range, permission) fail fast.
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await sheets.spreadsheets.values.append({
        spreadsheetId: sheet.sheet_id,
        range: `'${sheet.sheet_name}'!A:${lastCol}`,
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
