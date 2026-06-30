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

/** Like findColumnIndex but matches when the header STARTS WITH the prefix —
 *  needed for the long multi-line headers (e.g. "Company Address\nPlease…"). */
function findColumnStartsWith(headers: string[], ...prefixes: string[]): number {
  for (const p of prefixes) {
    const idx = headers.findIndex((h) => h.toLowerCase().trim().startsWith(p.toLowerCase().trim()));
    if (idx !== -1) return idx;
  }
  return -1;
}

export interface ClientTrackerRow {
  clientAbbreviation: string;
  status: string;
  churnDate: string;
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
  const churnIdx = findColumnIndex(headers, "Churn Date");

  if (abbrIdx === -1 || statusIdx === -1) {
    throw new Error(`Client Tracker: missing columns (abbreviation=${abbrIdx}, status=${statusIdx})`);
  }

  const results: ClientTrackerRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const abbr = rows[i][abbrIdx]?.toString()?.trim();
    const status = rows[i][statusIdx]?.toString()?.trim();
    const churnDate = churnIdx === -1 ? "" : (rows[i][churnIdx]?.toString()?.trim() || "");
    if (abbr) {
      results.push({ clientAbbreviation: abbr, status: status || "Unknown", churnDate });
    }
  }

  return results;
}

/**
 * The set of client TAGS that are CHURNED — defined as Status containing
 * "Churned" AND a non-empty Churn Date. A "Churned" status with no date is a
 * waitlisted/returning client and is treated as active.
 *
 * Combined abbreviations (e.g. "JPDFW & JPK", "CPGH & CPGA") are split on
 * " & " / " and " into individual tags; an "&" WITHOUT surrounding spaces is
 * kept intact (so "JPC&A", "K&LCS" stay single tags). Tags are upper-cased.
 */
export interface ChurnedClient { tag: string; churnDate: string }

/** Parse a Client-Tracker churn-date cell to a Date, or null if unparseable. */
function parseChurnDate(s: string): Date | null {
  const t = (s || "").trim();
  if (!t) return null;
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Clients CHURNED as of today — Status contains "Churn" AND the Churn Date is
 * present and on/before today. A FUTURE churn date means the client is scheduled
 * to churn but is still active, so it is NOT churned yet. An unparseable date is
 * treated as churned (status says so and a date was entered).
 * Combined abbreviations ("DBSM & DBSA") split like fetchChurnedClientTags.
 */
export async function fetchChurnedClients(): Promise<ChurnedClient[]> {
  const rows = await fetchClientTracker();
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
  const out: ChurnedClient[] = [];
  for (const r of rows) {
    if (!/churn/i.test(r.status)) continue;
    if (!r.churnDate) continue; // status churned but no date → not actually churned
    const d = parseChurnDate(r.churnDate);
    if (d && d.getTime() > endOfToday.getTime()) continue; // future churn → still active
    for (const t of r.clientAbbreviation.split(/\s+&\s+|\s+and\s+/i)) {
      const tag = t.trim().toUpperCase();
      if (tag) out.push({ tag, churnDate: r.churnDate.trim() });
    }
  }
  return out;
}

export async function fetchChurnedClientTags(): Promise<Set<string>> {
  return new Set((await fetchChurnedClients()).map((c) => c.tag));
}

/**
 * Each client tag's nurture GROUP (1 or 2) from the instance-mapping sheet
 * (a SEPARATE spreadsheet). "Sheet1" is column-positional with a header row:
 *   col A = Group-1 client tags ("B2B #1 (OutboundHero) & B2C #1 (CleaningOutbound)")
 *   col B = Group-2 client tags ("B2B #2 (FacilityReach) & B2C #2 (OutboundClean)")
 * (The sheet previously had "DONE" boolean columns at B/D with Group 2 in col C;
 *  those were removed, so Group 2 now sits directly in column B.)
 * Combined abbreviations ("DBSM & DBSA") split like fetchChurnedClientTags.
 * Returns Map<TAG_UPPER, 1|2>.
 */
const GROUPS_SPREADSHEET_ID = "1P-5H4pxB-cRO0i2tp6WjXNN77ibIB4hCnNTuyRzQOYw";

export async function fetchClientGroups(): Promise<Map<string, 1 | 2>> {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GROUPS_SPREADSHEET_ID,
    range: "'Sheet1'!A:C",
  });
  const rows = res.data.values || [];
  const out = new Map<string, 1 | 2>();
  const addCell = (cell: unknown, group: 1 | 2) => {
    const raw = (cell?.toString() || "").trim();
    if (!raw) return;
    for (const t of raw.split(/\s+&\s+|\s+and\s+/i)) {
      const tag = t.trim().toUpperCase();
      // Skip header fragments / the DONE-column truthy values.
      if (!tag || tag === "TRUE" || tag === "FALSE" || tag === "DONE") continue;
      if (/B2B|B2C|OUTBOUNDHERO|CLEANINGOUTBOUND|FACILITYREACH|OUTBOUNDCLEAN/i.test(tag)) continue;
      out.set(tag, group);
    }
  };
  for (let i = 1; i < rows.length; i++) {   // skip header row
    addCell(rows[i][0], 1); // col A → Group 1
    addCell(rows[i][1], 2); // col B → Group 2
  }
  return out;
}

export interface OnboardingFormRow {
  clientAbbreviation: string;
  exclusionIndustries: string;
  inclusionLocations: string;
  /** Client's office anchor — Column G "Client Office ({City, State} or {ZIP})",
   *  falling back to Column F "Company Address" when G is blank. Used by the
   *  location audit as the precise point to measure lead distance FROM. */
  hqAnchor: string;
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
  // hq_anchor: Column G "Client Office ({City, State} or {ZIP})" (exact),
  // with Column F "Company Address…" as fallback.
  const hqIdx = findColumnIndex(headers, "Client Office ({City, State} or {ZIP})");
  const hqIdxLoose = hqIdx !== -1 ? hqIdx : findColumnStartsWith(headers, "Client Office");
  const addressIdx = findColumnStartsWith(headers, "Company Address");

  if (abbrIdx === -1) {
    throw new Error(`Onboarding Form: missing Client Abbreviation column`);
  }

  const results: OnboardingFormRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const abbr = rows[i][abbrIdx]?.toString()?.trim();
    if (abbr) {
      const hq = hqIdxLoose !== -1 ? (rows[i][hqIdxLoose]?.toString()?.trim() || "") : "";
      const addr = addressIdx !== -1 ? (rows[i][addressIdx]?.toString()?.trim() || "") : "";
      results.push({
        clientAbbreviation: abbr,
        exclusionIndustries: exclusionIdx !== -1 ? (rows[i][exclusionIdx]?.toString()?.trim() || "") : "",
        inclusionLocations: inclusionIdx !== -1 ? (rows[i][inclusionIdx]?.toString()?.trim() || "") : "",
        hqAnchor: hq || addr,
      });
    }
  }

  return results;
}
