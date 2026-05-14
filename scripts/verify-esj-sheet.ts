/**
 * Quick sanity check: confirm the new external Google Sheets registry
 * resolves the ESJ sheet (and a couple of others) before we ship.
 *
 *   npx tsx --env-file=.env.local scripts/verify-esj-sheet.ts
 */

import { getSheetForClient } from "../lib/google-sheets-registry";

async function main() {
  const tags = ["ESJ", "BHS", "DOES_NOT_EXIST"];
  for (const tag of tags) {
    const sheet = await getSheetForClient(tag);
    if (sheet) {
      console.log(`${tag}: ✓ ${sheet.name} → tab "${sheet.sheetName}" (id ${sheet.id})`);
    } else {
      console.log(`${tag}: ✗ not registered`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
