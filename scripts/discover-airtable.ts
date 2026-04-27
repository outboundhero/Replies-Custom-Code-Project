/**
 * Discover Airtable schema for one base.
 *
 * Usage:
 *   npx tsx scripts/discover-airtable.ts [baseId]
 *
 * Defaults to appqZiSdsbeBCuHEp (Section 1, the default base used in lib/airtable.ts).
 *
 * Output:
 *   1. Human-readable summary to stdout (table names, primary field, fields with types)
 *   2. JSON dump to tmp/airtable-schema-{baseId}.json (full structure for offline review)
 *
 * Use this to figure out the field-name mapping for the backfill script
 * (which Airtable column holds the lead email, the reply body, etc.).
 *
 * Requires AIRTABLE_PAT in .env.local with `schema.bases:read` scope.
 */

import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { listBaseSchema } from "../lib/airtable";

config({ path: ".env.local" });

const DEFAULT_BASE_ID = "appqZiSdsbeBCuHEp"; // Section 1

async function main() {
  const baseId = process.argv[2] || DEFAULT_BASE_ID;

  if (!process.env.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env.local");
    process.exit(1);
  }

  console.log(`Fetching schema for base ${baseId}…\n`);

  const tables = await listBaseSchema(baseId);
  if (tables.length === 0) {
    console.log("No tables returned. Check that the PAT has access to this base and the schema.bases:read scope.");
    return;
  }

  console.log(`Base: ${baseId}`);
  console.log("─".repeat(60));

  for (const table of tables) {
    const primary = table.fields.find((f) => f.id === table.primaryFieldId);
    console.log(`\nTable: ${table.id} (${table.name})${primary ? `  [primary: ${primary.name}]` : ""}`);
    if (table.description) console.log(`  ${table.description}`);

    const namePad = Math.max(20, ...table.fields.map((f) => f.name.length));
    for (const field of table.fields) {
      const choices = extractChoices(field);
      const choicesText = choices.length > 0 ? `   [${choices.slice(0, 6).join(", ")}${choices.length > 6 ? `, +${choices.length - 6} more` : ""}]` : "";
      console.log(`  • ${field.name.padEnd(namePad)} ${field.type.padEnd(20)}${choicesText}`);
    }
  }

  // Dump full JSON for offline inspection
  const outPath = resolve(process.cwd(), "tmp", `airtable-schema-${baseId}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(tables, null, 2));
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Wrote full schema dump to ${outPath}`);
  console.log(`${tables.length} table${tables.length === 1 ? "" : "s"} discovered.`);
}

function extractChoices(field: { type: string; options?: unknown }): string[] {
  if (!field.options || typeof field.options !== "object") return [];
  const opts = field.options as { choices?: Array<{ name: string }> };
  if (Array.isArray(opts.choices)) return opts.choices.map((c) => c.name);
  return [];
}

main().catch((err) => {
  console.error("Discovery failed:", err);
  process.exit(1);
});
