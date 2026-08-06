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

export interface ClientGroupRecord { tag: string; group: 1 | 2; status: string; churnDate: string }

/**
 * The SINGLE SOURCE OF TRUTH for client directory data — group allocation,
 * Status, and Churn Date — from the "Groups" tab of the onboarding-form-responses
 * spreadsheet (replaces the old Client Tracker tab for all three).
 *
 * The tab has TWO client-tag columns, each followed by its own Status / Churn
 * Date / Plan metadata columns:
 *   Group-1 tags → header "B2B #1 (OutboundHero) & B2C #1 (CleaningOutbound)"
 *   Group-2 tags → header "B2B #2 (FacilityReach) & B2C #2 (OutboundClean)"
 *
 * Every column is located BY HEADER, never by fixed index — the two tag columns
 * by "#1"/"#2", and each group's Status/Churn Date by the first such header AFTER
 * its tag column (bounded by the next group). This survives inserted/removed
 * metadata columns (a "Churn Date" column added 2026-08 shifted Group-2 tags and
 * silently broke a hard-coded index). Combined abbreviations ("DBSM & DBSA") are
 * split; each split tag inherits that row's status + churn date. "Not Found"/"N/A"
 * churn cells are treated as no date.
 */
export async function fetchClientGroupRecords(): Promise<ClientGroupRecord[]> {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "'Groups'!A:Z",
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const header = (rows[0] || []).map((h) => (h?.toString() || "").toLowerCase());
  const g1col = header.findIndex((h) => h.includes("#1") || /\bgroup\s*1\b/.test(h));
  const g2col = header.findIndex((h) => h.includes("#2") || /\bgroup\s*2\b/.test(h));
  if (g1col === -1 && g2col === -1) {
    throw new Error("Groups tab: could not locate the #1/#2 tag columns by header");
  }
  // First header containing `kw` in (start, end) — the group's own Status/Churn col.
  const colAfter = (start: number, end: number, kw: string): number => {
    if (start === -1) return -1;
    const stop = end === -1 ? header.length : end;
    for (let i = start + 1; i < stop; i++) if (header[i].includes(kw)) return i;
    return -1;
  };
  const g1status = colAfter(g1col, g2col, "status"), g1churn = colAfter(g1col, g2col, "churn");
  const g2status = colAfter(g2col, header.length, "status"), g2churn = colAfter(g2col, header.length, "churn");

  // Defensive: a real client tag, not a header fragment / instance / status / plan / date.
  const isTag = (t: string): boolean =>
    !!t
    && !/^(TRUE|FALSE|DONE|ACTIVE|CHURNED?|PAUSED|NOT FOUND|N\/A)$/i.test(t)
    && !/B2B|B2C|OUTBOUNDHERO|CLEANINGOUTBOUND|FACILITYREACH|OUTBOUNDCLEAN/i.test(t)
    && !/\bTIER\b|\bTRIAL\b|\bBASE\b/i.test(t)
    && !(/^\d/.test(t) && /\//.test(t));

  const out: ClientGroupRecord[] = [];
  const addGroup = (row: string[], tagCol: number, stCol: number, chCol: number, group: 1 | 2) => {
    if (tagCol === -1) return;
    const rawTag = (row[tagCol]?.toString() || "").trim();
    if (!rawTag) return;
    const status = stCol !== -1 ? (row[stCol]?.toString() || "").trim() : "";
    const churnRaw = chCol !== -1 ? (row[chCol]?.toString() || "").trim() : "";
    const churnDate = /^(not found|n\/a|-|—)$/i.test(churnRaw) ? "" : churnRaw;
    for (const t of rawTag.split(/\s+&\s+|\s+and\s+/i)) {
      const tag = t.trim().toUpperCase();
      if (!isTag(tag)) continue;
      out.push({ tag, group, status, churnDate });
    }
  };
  for (let i = 1; i < rows.length; i++) {   // skip header row
    addGroup(rows[i], g1col, g1status, g1churn, 1);
    addGroup(rows[i], g2col, g2status, g2churn, 2);
  }
  return out;
}

/** Each client tag's nurture GROUP (1 or 2), derived from fetchClientGroupRecords. */
export async function fetchClientGroups(): Promise<Map<string, 1 | 2>> {
  const out = new Map<string, 1 | 2>();
  for (const r of await fetchClientGroupRecords()) out.set(r.tag, r.group);
  return out;
}

/**
 * Churned clients per the Groups tab (the new source of truth). A client is
 * churned ONLY when Status contains "Churn" AND its Churn Date is present AND on/
 * before today. Future churn dates → still active (scheduled). Missing/unparseable
 * date → NOT churned (the rule requires a date that has actually passed).
 */
export async function fetchChurnedFromGroups(): Promise<ChurnedClient[]> {
  const recs = await fetchClientGroupRecords();
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
  const out: ChurnedClient[] = [];
  for (const r of recs) {
    if (!/churn/i.test(r.status)) continue;
    const d = parseChurnDate(r.churnDate);
    if (!d) continue;                                    // no/invalid date → needs a passed date → active
    if (d.getTime() > endOfToday.getTime()) continue;    // future churn → still active
    out.push({ tag: r.tag, churnDate: r.churnDate.trim() });
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
  /** "Status" column (Active / Not Found / Churned / Paused). */
  status: string;
  /** "Client Type" column (Cleaning / Non-Cleaning). Only Active+Cleaning
   *  clients are suggested by the cross-client matcher. */
  clientType: string;
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
  const statusIdx = findColumnIndex(headers, "Status");
  const typeIdx = findColumnIndex(headers, "Client Type");

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
        status: statusIdx !== -1 ? (rows[i][statusIdx]?.toString()?.trim() || "") : "",
        clientType: typeIdx !== -1 ? (rows[i][typeIdx]?.toString()?.trim() || "") : "",
      });
    }
  }

  return results;
}
