/**
 * Google Sheets API integration.
 * Fetches client tracker and onboarding form data from the shared spreadsheet.
 */

import { google } from "googleapis";

const SPREADSHEET_ID = "1MGqSgGNoeN6WgjZnT7_Ij_nZftyyj7Z9DT77rVYLKuQ";

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

function findColumnIndex(headers: string[], ...names: string[]): number {
  for (const name of names) {
    const idx = headers.findIndex((h) => h.toLowerCase().trim() === name.toLowerCase().trim());
    if (idx !== -1) return idx;
  }
  return -1;
}

export interface ClientTrackerRow {
  clientAbbreviation: string;
  status: string;
}

export async function fetchClientTracker(): Promise<ClientTrackerRow[]> {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "'Client Tracker'",
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0].map((h: string) => h?.toString() || "");
  const abbrIdx = findColumnIndex(headers, "Client Abbreviation", "Client Abbrevation");
  const statusIdx = findColumnIndex(headers, "Status");

  if (abbrIdx === -1 || statusIdx === -1) {
    throw new Error(`Client Tracker: missing columns (abbreviation=${abbrIdx}, status=${statusIdx})`);
  }

  const results: ClientTrackerRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const abbr = rows[i][abbrIdx]?.toString()?.trim();
    const status = rows[i][statusIdx]?.toString()?.trim();
    if (abbr) {
      results.push({ clientAbbreviation: abbr, status: status || "Unknown" });
    }
  }

  return results;
}

export interface OnboardingFormRow {
  clientAbbreviation: string;
  exclusionIndustries: string;
  inclusionLocations: string;
}

export async function fetchOnboardingForm(): Promise<OnboardingFormRow[]> {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "'Onboarding Form Responses'",
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0].map((h: string) => h?.toString() || "");
  const abbrIdx = findColumnIndex(headers, "Client Abbreviation", "Client Abbrevation");
  const exclusionIdx = findColumnIndex(
    headers,
    "Exclusion industries & keywords (e.g. we don't work with restaurants, religious institutions, education, nightclubs, etc):",
    "Exclusion industries & keywords",
    "Exclusion industries"
  );
  const inclusionIdx = findColumnIndex(
    headers,
    "Inclusion locations (make sure to include zip codes, counties, or cities + states):",
    "Inclusion locations",
  );

  if (abbrIdx === -1) {
    throw new Error(`Onboarding Form: missing Client Abbreviation column`);
  }

  const results: OnboardingFormRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const abbr = rows[i][abbrIdx]?.toString()?.trim();
    if (abbr) {
      results.push({
        clientAbbreviation: abbr,
        exclusionIndustries: exclusionIdx !== -1 ? (rows[i][exclusionIdx]?.toString()?.trim() || "") : "",
        inclusionLocations: inclusionIdx !== -1 ? (rows[i][inclusionIdx]?.toString()?.trim() || "") : "",
      });
    }
  }

  return results;
}
