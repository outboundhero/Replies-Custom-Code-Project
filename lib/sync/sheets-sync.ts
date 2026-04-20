/**
 * Sync client Google Sheet mappings from the tracked-sheets API.
 */

import supabase from "@/lib/supabase";

const SHEETS_API_URL = "https://google-sheets-dashboard-nine.vercel.app/api/external/tracked-sheets";
const SHEETS_API_TOKEN = "outboundhero2024";

export async function syncClientSheets(): Promise<number> {
  const res = await fetch(SHEETS_API_URL, {
    headers: { Authorization: `Bearer ${SHEETS_API_TOKEN}` },
  });

  if (!res.ok) throw new Error(`Tracked sheets API failed: ${res.status}`);

  const data = await res.json();
  const sheets: Array<{ id: string; clientTag: string; sheetName: string; name: string }> = data.sheets || [];

  const records = sheets.map((s) => ({
    client_tag: s.clientTag,
    sheet_id: s.id,
    sheet_name: s.sheetName,
    display_name: s.name,
    synced_at: new Date().toISOString(),
  }));

  if (records.length > 0) {
    const { error } = await supabase
      .from("client_sheets")
      .upsert(records, { onConflict: "client_tag" });

    if (error) throw new Error(`Failed to sync client_sheets: ${error.message}`);
  }

  return records.length;
}
