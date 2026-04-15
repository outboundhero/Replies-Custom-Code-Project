/**
 * One-time script to create qualification fields in all Airtable bases.
 * Run: npx tsx scripts/setup-airtable-qualification-fields.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;

interface FieldDef {
  name: string;
  type: string;
  options?: unknown;
}

const FIELDS: FieldDef[] = [
  {
    name: "Industry Audit",
    type: "singleSelect",
    options: {
      choices: [
        { name: "Passed", color: "greenBright" },
        { name: "Failed", color: "redBright" },
        { name: "Residential", color: "yellowBright" },
      ],
    },
  },
  {
    name: "Location Audit",
    type: "singleSelect",
    options: {
      choices: [
        { name: "Passed", color: "greenBright" },
        { name: "Failed", color: "redBright" },
      ],
    },
  },
  {
    name: "Qualification Reason",
    type: "singleLineText",
  },
  {
    name: "Suggested Client",
    type: "singleLineText",
  },
];

async function createField(baseId: string, tableId: string, field: FieldDef) {
  const res = await fetch(
    `https://api.airtable.com/v0/meta/bases/${baseId}/tables/${tableId}/fields`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(field),
    }
  );

  if (res.ok) {
    console.log(`  ✓ Created "${field.name}"`);
  } else {
    const body = await res.text();
    if (res.status === 422 && body.includes("already exists")) {
      console.log(`  - "${field.name}" already exists, skipping`);
    } else {
      console.error(`  ✗ Failed to create "${field.name}": ${res.status} ${body}`);
    }
  }
}

async function main() {
  const sections = await db.execute("SELECT id, name, airtable_base_id, airtable_table_id FROM sections ORDER BY id");

  console.log(`Found ${sections.rows.length} sections\n`);

  for (const section of sections.rows) {
    const baseId = section.airtable_base_id as string;
    const tableId = section.airtable_table_id as string;
    console.log(`${section.name} (${baseId} / ${tableId}):`);

    for (const field of FIELDS) {
      await createField(baseId, tableId, field);
    }
    console.log();
  }

  console.log("Done!");
}

main().catch(console.error);
