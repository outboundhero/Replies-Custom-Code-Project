/**
 * Single source of truth for per-client Google Sheet IDs.
 *
 * The canonical registry lives in a separate Vercel app
 * (google-sheets-dashboard-nine) — not Supabase — so this module
 * is the only place that knows where to fetch from.
 *
 * Cached in-process for 10 minutes. The registry endpoint returns
 * the entire list (~99 sheets) in a single ~150 ms call, so per-client
 * lookups become O(1) after the first warm hit.
 */

interface RegistrySheet {
  id: string;            // spreadsheet id (the part between /d/ and /edit in the URL)
  name: string;          // human-friendly file name
  clientTag: string;     // matches replies.client_tag
  sheetName: string;     // tab name within the spreadsheet
  addedAt?: string;
  syncedAt?: string;
}

interface RegistryResponse {
  sheets: RegistrySheet[];
  count: number;
  lastSyncedAt: string;
}

const REGISTRY_URL =
  process.env.GOOGLE_SHEETS_REGISTRY_URL ||
  "https://google-sheets-dashboard-nine.vercel.app/api/external/tracked-sheets";
const REGISTRY_TOKEN = process.env.GOOGLE_SHEETS_REGISTRY_TOKEN || "outboundhero2024";
const TTL_MS = 10 * 60 * 1000;

let cache: { data: RegistrySheet[]; ts: number } | null = null;

async function loadRegistry(): Promise<RegistrySheet[]> {
  const now = Date.now();
  if (cache && now - cache.ts < TTL_MS) return cache.data;

  const res = await fetch(REGISTRY_URL, {
    headers: { Authorization: `Bearer ${REGISTRY_TOKEN}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Registry fetch failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as RegistryResponse;
  const data = Array.isArray(json?.sheets) ? json.sheets : [];
  cache = { data, ts: now };
  return data;
}

/** Every registered client sheet (used by the handoff-column backfill). */
export async function listRegistrySheets(): Promise<RegistrySheet[]> {
  return loadRegistry();
}

/**
 * Real client-tag tokens for a registry field. The external registry is sloppy:
 * some entries pollute the tag with a suffix ("CCHS: Leads") and some bundle
 * several clients into one sheet ("JPCIN / JPCHI", "CVJLOU & CVJLEX"). We:
 *   - drop anything after a ":" ("CCHS: Leads" → "CCHS"), then
 *   - split on "/" or a SPACED " & " (multi-tag separators) — but NOT a bare "&",
 *     so single tags like "K&LCS", "JPC&A", "TM&VC" stay intact.
 */
function tagTokens(raw: string | null | undefined): string[] {
  return String(raw || "")
    .split(":")[0]
    .split(/\s*\/\s*|\s+&\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/** Look up a client's sheet by tag. Case-insensitive, and tolerant of the
 *  registry's malformed/bundled tags (see tagTokens). Returns null if not found. */
export async function getSheetForClient(clientTag: string): Promise<RegistrySheet | null> {
  if (!clientTag || clientTag === "N/A") return null;
  const sheets = await loadRegistry();
  const wanted = clientTag.trim().toLowerCase();
  // 1. Exact clientTag match — the clean, common case.
  const exact = sheets.find((s) => (s.clientTag || "").trim().toLowerCase() === wanted);
  if (exact) return exact;
  // 2. Tolerant token match on the clientTag OR the sheet name (multi-tag sheets
  //    often name every client in `name`, e.g. "CVJLOU & CVJLEX: Leads").
  return sheets.find(
    (s) => tagTokens(s.clientTag).includes(wanted) || tagTokens(s.name).includes(wanted),
  ) ?? null;
}
