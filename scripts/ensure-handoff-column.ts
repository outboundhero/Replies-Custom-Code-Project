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
// Sheets API caps read/write at ~60/min per user. Pace requests + back off on
// quota so a 117-sheet run doesn't trip "Quota exceeded".
const GAP_MS = 1300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isQuota = (e: unknown) => /quota exceeded|rate limit|RESOURCE_EXHAUSTED|\b429\b/i.test((e as Error)?.message || "");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (!isQuota(e) || attempt >= 5) throw e;
      const wait = Math.min(2 ** attempt * 5000, 60000); // quota is per-MINUTE — wait long
      console.log(`    …quota hit, backing off ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
}

// The handoff column must never land inside the A:W (23-col) data range, even on
// sheets with sparse header rows — mirror lib/sheet-handoff.ts PUSH_COLUMN_COUNT.
const PUSH_COLUMN_COUNT = 23;

async function main() {
  const sheetsApi = google.sheets({ version: "v4", auth: getAuth() });
  const registry = await listRegistrySheets();
  console.log(`${registry.length} registered sheets · mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  let added = 0, present = 0, failed = 0;
  for (const s of registry) {
    const label = `${s.clientTag} (${s.name} · '${s.sheetName}')`;
    try {
      const res = await withRetry(() => sheetsApi.spreadsheets.values.get({
        spreadsheetId: s.id,
        range: `'${s.sheetName}'!1:1`,
      }));
      const headers: string[] = (res.data.values?.[0] || []).map((h) => String(h || ""));
      const has = headers.some((h) => h.trim().toLowerCase() === HANDOFF_HEADER.toLowerCase());
      if (has) { present++; console.log(`  ✓ present   ${label}`); await sleep(GAP_MS); continue; }

      const idx = Math.max(headers.length, PUSH_COLUMN_COUNT);
      if (APPLY) {
        await withRetry(() => sheetsApi.spreadsheets.values.update({
          spreadsheetId: s.id,
          range: `'${s.sheetName}'!${colLetter(idx)}1`,
          valueInputOption: "RAW",
          requestBody: { values: [[HANDOFF_HEADER]] },
        }));
      }
      added++;
      console.log(`  ${APPLY ? "＋ added" : "→ would add"} ${label}  @ col ${colLetter(idx)}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ FAILED    ${label} — ${(e as Error).message}`);
    }
    await sleep(GAP_MS);
  }

  console.log(`\nDone. present=${present} ${APPLY ? "added" : "would-add"}=${added} failed=${failed}`);
  if (!APPLY && added) console.log("Re-run with --apply to create the columns.");
}

main().catch((e) => { console.error(e); process.exit(1); });
