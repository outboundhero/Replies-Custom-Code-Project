/**
 * Push a qualified lead to the client's Google Sheet.
 * Called when lead is marked as: Interested, Meeting Ready Lead, Follow Up,
 * Referral Given, or Internally Forwarded.
 */

import { google } from "googleapis";
import { getSheetForClient } from "@/lib/google-sheets-registry";

function getAuth() {
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

export async function pushToSheet(clientTag: string, data: ReplyData): Promise<{ ok: boolean; error?: string }> {
  // Look up client's sheet from the canonical external registry.
  let sheet: { sheet_id: string; sheet_name: string } | null = null;
  try {
    const found = await getSheetForClient(clientTag);
    if (found) sheet = { sheet_id: found.id, sheet_name: found.sheetName };
  } catch (err) {
    return { ok: false, error: `Sheet registry fetch failed: ${(err as Error).message}` };
  }

  if (!sheet) {
    return { ok: false, error: `No Google Sheet registered for client ${clientTag}. Add it in the tracked-sheets dashboard first.` };
  }

  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

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

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheet.sheet_id,
      range: `'${sheet.sheet_name}'!A:W`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });

    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
