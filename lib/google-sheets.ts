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
 * Map of client TAG (upper) → "Go Live Date" cell (raw string, e.g. "9/23/2026"),
 * from the Client Tracker. Used to keep a NOT-yet-launched client's campaigns
 * from being force-activated: a client whose go-live date is in the future is not
 * live yet. Bundled abbreviations ("JPDFW & JPK") map each tag to the same date.
 * Cached briefly so the activation sweep doesn't re-pull the sheet every tick.
 */
let _goLiveCache: { map: Map<string, string>; ts: number } | null = null;
export async function fetchGoLiveDates(): Promise<Map<string, string>> {
  if (_goLiveCache && Date.now() - _goLiveCache.ts < 5 * 60_000) return _goLiveCache.map;
  const sheets = google.sheets({ version: "v4", auth: getAuth() });
  // Several crons read the sheet at the top of the hour, which can trip Google's
  // per-minute read quota. That quota resets within a minute, so retry after a
  // pause; if it still fails, reuse a read from the last hour rather than making
  // every go-live gate skip its run.
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "'Client Tracker'" });
      break;
    } catch (e) {
      const quota = /quota|rate limit|429/i.test(String((e as Error)?.message ?? e));
      if (quota && attempt < 2) { await new Promise((r) => setTimeout(r, attempt === 0 ? 8_000 : 20_000)); continue; }
      if (_goLiveCache && Date.now() - _goLiveCache.ts < 60 * 60_000) return _goLiveCache.map;
      throw e;
    }
  }
  const rows = res.data.values || [];
  const out = new Map<string, string>();
  if (rows.length >= 2) {
    const headers = rows[0].map((h: string) => h?.toString() || "");
    const abbrIdx = findColumnIndex(headers, "Client Abbreviation", "Client Abbrevation");
    const goLiveIdx = findColumnIndex(headers, "Go Live Date");
    if (abbrIdx !== -1 && goLiveIdx !== -1) {
      for (let i = 1; i < rows.length; i++) {
        const rawAbbr = rows[i][abbrIdx]?.toString()?.trim();
        const goLive = rows[i][goLiveIdx]?.toString()?.trim() || "";
        if (!rawAbbr) continue;
        // Split bundled tags the same way churn parsing does.
        for (const tag of rawAbbr.split(/\s+&\s+|\s+and\s+|\s*\/\s*/i).map((t: string) => t.trim()).filter(Boolean)) {
          out.set(tag.toUpperCase(), goLive);
        }
      }
    }
  }
  _goLiveCache = { map: out, ts: Date.now() };
  return out;
}

/**
 * Client tags NOT yet live — their "Go Live Date" (+ optional `lagDays`) is in
 * the FUTURE (strictly after today). A blank/unparseable date is treated as live
 * (never blocks an established client).
 *
 * `lagDays = 0` (default): the raw go-live gate — used to keep pre-launch clients
 * out of campaign auto-activation.
 * `lagDays > 0`: go-live + a lag — used so NURTURE doesn't start until the agreed
 * lag past go-live (nurture must not run before the main campaigns have had time
 * to work). Pass NURTURE_GOLIVE_LAG_DAYS for the nurture push/activation paths.
 */
export async function fetchNotYetLiveTags(lagDays = 0): Promise<Set<string>> {
  const dates = await fetchGoLiveDates();
  const today = new Date();
  const todayNum = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
  const out = new Set<string>();
  for (const [tag, raw] of dates) {
    const m = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/); // M/D/YYYY or M-D-YY
    if (!m) continue; // blank / unrecognized → treat as live
    const [, mm, dd, yy] = m;
    let y = Number(yy); if (y < 100) y += 2000;
    // Compare against (go-live + lagDays) so nurture waits the agreed lag.
    const gate = new Date(Date.UTC(y, Number(mm) - 1, Number(dd) + lagDays));
    const gateNum = gate.getUTCFullYear() * 10000 + (gate.getUTCMonth() + 1) * 100 + gate.getUTCDate();
    if (gateNum > todayNum) out.add(tag); // go-live (+lag) still in the future → not yet eligible
  }
  return out;
}

/**
 * Days AFTER a client's Go Live Date before its nurture may start. Nurture must
 * never run before the main campaigns have had the agreed lag to work — and NEVER
 * for a pre-launch client. Set to the value agreed with the team. 0 = nurture may
 * start the moment the client goes live (still blocks all pre-launch nurture).
 */
export const NURTURE_GOLIVE_LAG_DAYS = 0;

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

export interface NewClientInfoRow {
  /** Every client tag on the row (a multi-market client lists several). */
  tags: string[];
  companyName: string;
  /** "Plan chosen" as written in the form, e.g. "Tier 1 (Base) = 20 Outlook Azure Domains". */
  plan: string;
  /** Start date as YYYY-MM-DD, or "" when the cell isn't a date. */
  startDate: string;
  contactNames: string;
  contactEmails: string[];
  primaryContactEmail: string;
  clientType: string;
  /** "Company area(s)" as typed, e.g. "All of Orange County, California". */
  area: string;
  /** "Company office address / Location", e.g. "Anaheim, California". */
  office: string;
}

/** "10/15/2026" (the form's format) or "2026-10-15" → "2026-10-15"; "" otherwise. */
export function parseSheetDate(raw: string): string {
  const s = (raw || "").trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : us ? [us[3], us[1], us[2]] : ["", "", ""];
  if (!y || Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return "";
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/**
 * The "New Client Information" tab (the sales hand-off form): one row per new
 * client with its tag(s), plan, start date and contacts. Columns are located by
 * header so inserted columns don't break it.
 */
export async function fetchNewClientInfo(): Promise<NewClientInfoRow[]> {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "'New Client Information'",
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];
  const headers = rows[0].map((h: string) => h?.toString() || "");
  const abbrIdx = findColumnStartsWith(headers, "Client company abbreviation");
  if (abbrIdx === -1) throw new Error("New Client Information: missing the client abbreviation column");
  const nameIdx = findColumnStartsWith(headers, "Company name");
  const planIdx = findColumnStartsWith(headers, "Plan chosen");
  const startIdx = findColumnStartsWith(headers, "Start date");
  const namesIdx = findColumnStartsWith(headers, "Name(s)");
  const emailsIdx = findColumnStartsWith(headers, "Email(s)");
  const primaryIdx = findColumnStartsWith(headers, "Primary point of contact person email");
  const typeIdx = findColumnStartsWith(headers, "Client type");
  const areaIdx = findColumnStartsWith(headers, "Company area");
  const officeIdx = findColumnStartsWith(headers, "Company office address");
  const cell = (row: string[], i: number) => (i === -1 ? "" : (row[i]?.toString() || "").trim());

  const out: NewClientInfoRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const tags = cell(rows[i], abbrIdx).split(/[,&/;\n]+|\s+and\s+/i).map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (!tags.length) continue;
    out.push({
      tags,
      companyName: cell(rows[i], nameIdx),
      plan: cell(rows[i], planIdx),
      startDate: parseSheetDate(cell(rows[i], startIdx)),
      contactNames: cell(rows[i], namesIdx),
      contactEmails: cell(rows[i], emailsIdx).match(/[^\s,;<>()]+@[^\s,;<>()]+\.[^\s,;<>()]+/g) || [],
      primaryContactEmail: cell(rows[i], primaryIdx),
      clientType: cell(rows[i], typeIdx),
      area: cell(rows[i], areaIdx).replace(/\s+/g, " "),
      office: cell(rows[i], officeIdx).replace(/\s+/g, " "),
    });
  }
  return out;
}

/**
 * Client tag → the "Company Website" answer on the Onboarding Form Responses
 * tab — where a new client's sending domains redirect. The newest row wins.
 */
export async function fetchOnboardingWebsites(): Promise<Map<string, string>> {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "'Onboarding Form Responses'" });
  const rows = res.data.values || [];
  const out = new Map<string, string>();
  if (rows.length < 2) return out;
  const headers = rows[0].map((h: string) => h?.toString() || "");
  const abbrIdx = findColumnIndex(headers, "Client Abbreviation", "Client Abbrevation");
  const siteIdx = findColumnStartsWith(headers, "Company Website");
  if (abbrIdx === -1 || siteIdx === -1) throw new Error("Onboarding Form: missing the Client Abbreviation or Company Website column");
  for (let i = 1; i < rows.length; i++) {
    const tag = rows[i][abbrIdx]?.toString()?.trim().toUpperCase();
    const site = rows[i][siteIdx]?.toString()?.trim();
    if (tag && site) out.set(tag, site);
  }
  return out;
}

/** One client's answers on the Onboarding Form that Reply Router's setup uses (CC list, signature, type). */
export interface OnboardingFormDetails {
  tag: string;
  /** "Email Address" — the person who filled the form. */
  email: string;
  companyName: string;
  phones: string;
  address: string;
  zip: string;
  website: string;
  /** "Provide the names and email addresses for everyone who should be CC'd …" as typed. */
  ccText: string;
  clientType: string;
}

/**
 * Client tag → that client's Onboarding Form answers (the newest row wins; a
 * row listing several tags counts for each).
 */
export async function fetchOnboardingFormDetails(): Promise<Map<string, OnboardingFormDetails>> {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "'Onboarding Form Responses'" });
  const rows = res.data.values || [];
  const out = new Map<string, OnboardingFormDetails>();
  if (rows.length < 2) return out;
  const headers = rows[0].map((h: string) => h?.toString() || "");
  const col = (...prefixes: string[]) => findColumnStartsWith(headers, ...prefixes);
  const abbrIdx = findColumnIndex(headers, "Client Abbreviation", "Client Abbrevation");
  if (abbrIdx === -1) throw new Error("Onboarding Form: missing the Client Abbreviation column");
  const idx = {
    email: findColumnIndex(headers, "Email Address"),
    company: col("Company Name"),
    phones: col("Direct Phone Number"),
    address: col("Company Address"),
    zip: col("Company Zip Code"),
    website: col("Company Website"),
    cc: col("Provide the names and email addresses"),
    type: findColumnIndex(headers, "Client Type"),
  };
  const cell = (r: unknown[], i: number) => (i === -1 ? "" : String(r[i] ?? "").trim());
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const tags = cell(r, abbrIdx).toUpperCase().split(/\s*(?:[\/,]|\s&\s|\band\b)\s*/i).map((t) => t.trim()).filter(Boolean);
    for (const tag of tags) {
      out.set(tag, {
        tag,
        email: cell(r, idx.email),
        companyName: cell(r, idx.company),
        phones: cell(r, idx.phones),
        address: cell(r, idx.address),
        zip: cell(r, idx.zip),
        website: cell(r, idx.website),
        ccText: cell(r, idx.cc),
        clientType: cell(r, idx.type),
      });
    }
  }
  return out;
}
