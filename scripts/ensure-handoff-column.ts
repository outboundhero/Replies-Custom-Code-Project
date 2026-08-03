/**
 * One-off: make sure every registered client leads-sheet has a "Lead handoff
 * email" column, so the column is present everywhere immediately (not only
 * lazily on the first Send Reply).
 *
 * Idempotent: sheets that already have the column (case-insensitive header) are
 * left untouched — no duplicate column is ever added.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/ensure-handoff-column.ts          # DRY RUN (lists what would change)
 *   npx tsx --env-file=.env.local scripts/ensure-handoff-column.ts --apply  # actually add the header
 */
import { google } from "googleapis";
import { getAuth } from "../lib/push-to-sheet";
import { listRegistrySheets } from "../lib/google-sheets-registry";
import { HANDOFF_HEADER, colLetter } from "../lib/sheet-handoff";

const APPLY = process.argv.includes("--apply");

async function main() {
  const sheetsApi = google.sheets({ version: "v4", auth: getAuth() });
  const registry = await listRegistrySheets();
  console.log(`${registry.length} registered sheets · mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  let added = 0, present = 0, failed = 0;
  for (const s of registry) {
    const label = `${s.clientTag} (${s.name} · '${s.sheetName}')`;
    try {
      const res = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: s.id,
        range: `'${s.sheetName}'!1:1`,
      });
      const headers: string[] = (res.data.values?.[0] || []).map((h) => String(h || ""));
      const has = headers.some((h) => h.trim().toLowerCase() === HANDOFF_HEADER.toLowerCase());
      if (has) { present++; console.log(`  ✓ present   ${label}`); continue; }

      const idx = headers.length;
      if (APPLY) {
        await sheetsApi.spreadsheets.values.update({
          spreadsheetId: s.id,
          range: `'${s.sheetName}'!${colLetter(idx)}1`,
          valueInputOption: "RAW",
          requestBody: { values: [[HANDOFF_HEADER]] },
        });
      }
      added++;
      console.log(`  ${APPLY ? "＋ added" : "→ would add"} ${label}  @ col ${colLetter(idx)}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ FAILED    ${label} — ${(e as Error).message}`);
    }
  }

  console.log(`\nDone. present=${present} ${APPLY ? "added" : "would-add"}=${added} failed=${failed}`);
  if (!APPLY && added) console.log("Re-run with --apply to create the columns.");
}

main().catch((e) => { console.error(e); process.exit(1); });
