/**
 * Add client tags to the "Client Tag" single-select dropdown in a section's
 * Airtable base — used when onboarding new client tags.
 *
 * Airtable's Meta API requires the FULL choices array on a field PATCH, and any
 * existing choice must be sent back with its `id` or it would be treated as a
 * rename/delete. This script therefore reads the current schema, passes every
 * existing choice through untouched, and only appends the missing ones.
 * Existing options are never renamed, recoloured, or removed.
 *
 * Requires AIRTABLE_PAT with `schema.bases:read` + `schema.bases:write`.
 *
 * Usage:
 *   tsx --env-file=.env.local scripts/airtable-add-client-tags.ts --section=8 SI CWSJ-OS
 *   tsx --env-file=.env.local scripts/airtable-add-client-tags.ts --section=8 --dry SI
 *   tsx --env-file=.env.local scripts/airtable-add-client-tags.ts --base=appXXXX --field="Client Tag" SI
 */
import db from "@/lib/db";
import { listBaseSchema } from "@/lib/airtable";

const AIRTABLE_API = "https://api.airtable.com/v0";
// Colors Airtable accepts for select choices; we cycle through for new options.
const PALETTE = [
  "blueLight2", "cyanLight2", "tealLight2", "greenLight2", "yellowLight2",
  "orangeLight2", "redLight2", "pinkLight2", "purpleLight2", "grayLight2",
];

interface Choice { id?: string; name: string; color?: string }

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const sectionArg = args.find((a) => a.startsWith("--section="))?.split("=")[1];
  const baseArg = args.find((a) => a.startsWith("--base="))?.split("=")[1];
  const fieldName = args.find((a) => a.startsWith("--field="))?.split("=")[1] || "Client Tag";
  const tags = args.filter((a) => !a.startsWith("--")).map((t) => t.trim()).filter(Boolean);

  if (!tags.length) throw new Error("No tags given. Example: --section=8 SI CWSJ-OS");
  if (!process.env.AIRTABLE_PAT) throw new Error("AIRTABLE_PAT not set");

  // Resolve the base: --base=… wins, else look the section up in Turso.
  let baseId = baseArg || "";
  if (!baseId) {
    if (!sectionArg) throw new Error("Pass --section=<n> or --base=<appId>");
    const r = await db.execute({
      sql: "SELECT name, airtable_base_id FROM sections WHERE name = ? OR name = ?",
      args: [`Section ${sectionArg}`, sectionArg],
    });
    if (!r.rows.length) throw new Error(`Section "${sectionArg}" not found in Turso sections`);
    baseId = String(r.rows[0].airtable_base_id);
    console.log(`Section ${sectionArg} → base ${baseId}`);
  }

  // Find the table + field holding the client-tag dropdown.
  const tables = await listBaseSchema(baseId);
  let tableId = "", fieldId = "", tableName = "";
  let choices: Choice[] = [];
  for (const t of tables) {
    const f = t.fields.find((x) => x.name === fieldName && (x.type === "singleSelect" || x.type === "multipleSelects"));
    if (f) {
      tableId = t.id; tableName = t.name; fieldId = f.id;
      choices = ((f.options as { choices?: Choice[] })?.choices || []).map((c) => ({ id: c.id, name: c.name, color: c.color }));
      break;
    }
  }
  if (!fieldId) throw new Error(`No "${fieldName}" select field found in base ${baseId}`);
  console.log(`Table "${tableName}" (${tableId}) · field "${fieldName}" (${fieldId}) · ${choices.length} existing options`);

  const existing = new Set(choices.map((c) => c.name));
  const toAdd = tags.filter((t) => !existing.has(t));
  const already = tags.filter((t) => existing.has(t));
  if (already.length) console.log(`Already present (skipping): ${already.join(", ")}`);
  if (!toAdd.length) { console.log("Nothing to add — all tags already exist."); return; }
  console.log(`Adding: ${toAdd.join(", ")}`);

  const next: Choice[] = [
    ...choices,
    ...toAdd.map((name, i) => ({ name, color: PALETTE[(choices.length + i) % PALETTE.length] })),
  ];

  if (dry) {
    console.log(`\n[dry run] would PATCH field ${fieldId}: ${choices.length} → ${next.length} options`);
    return;
  }

  const res = await fetch(`${AIRTABLE_API}/meta/bases/${baseId}/tables/${tableId}/fields/${fieldId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ options: { choices: next } }),
  });
  if (!res.ok) throw new Error(`Airtable field PATCH failed (${res.status}): ${await res.text()}`);

  // Verify by re-reading the schema.
  const after = await listBaseSchema(baseId);
  const verify = after.find((t) => t.id === tableId)?.fields.find((f) => f.id === fieldId);
  const names = new Set(((verify?.options as { choices?: Choice[] })?.choices || []).map((c) => c.name));
  console.log(`\n✓ Field now has ${names.size} options`);
  for (const t of tags) console.log(`  ${names.has(t) ? "✓" : "✗"} ${t}`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
