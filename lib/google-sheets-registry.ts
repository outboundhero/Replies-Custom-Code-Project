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

/** Look up a client's sheet by tag. Case-insensitive. Returns null if not found. */
export async function getSheetForClient(clientTag: string): Promise<RegistrySheet | null> {
  if (!clientTag || clientTag === "N/A") return null;
  const sheets = await loadRegistry();
  const wanted = clientTag.trim().toLowerCase();
  return sheets.find((s) => (s.clientTag || "").trim().toLowerCase() === wanted) ?? null;
}
