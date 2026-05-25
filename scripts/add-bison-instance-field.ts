/**
 * One-off: add a "Bison Instance" singleLineText field to every Airtable
 * (Leads + Meeting Ready) table the Reply Router writes to.
 *
 * Idempotent: skips any (base, table) pair that already has the field.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/add-bison-instance-field.ts        # DRY RUN
 *   npx tsx --env-file=.env.local scripts/add-bison-instance-field.ts --apply
 */
import db from "../lib/db";
import { listBaseSchema } from "../lib/airtable";

const FIELD_NAME = "Bison Instance";
const FIELD_TYPE = "singleLineText";
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;

async function addField(baseId: string, tableId: string): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables/${tableId}/fields`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: FIELD_NAME, type: FIELD_TYPE }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  if (!AIRTABLE_PAT) throw new Error("AIRTABLE_PAT env var missing");
  const apply = process.argv.includes("--apply");
  if (!apply) console.log("DRY RUN — pass --apply to actually create the fields\n");

  // 1. Gather every (base, table) pair
  const sections = await db.execute(
    "SELECT name, airtable_base_id, airtable_table_id, meeting_ready_table_id FROM sections ORDER BY name",
  );
  const untracked = await db.execute(
    "SELECT airtable_base_id, airtable_table_id, meeting_ready_table_id FROM untracked_config WHERE id = 1",
  );
  const pairs = new Set<string>();
  for (const s of [...sections.rows, ...untracked.rows]) {
    if (s.airtable_base_id && s.airtable_table_id) {
      pairs.add(`${s.airtable_base_id}/${s.airtable_table_id}`);
    }
    if (s.airtable_base_id && s.meeting_ready_table_id) {
      pairs.add(`${s.airtable_base_id}/${s.meeting_ready_table_id}`);
    }
  }

  // 2. Group by base so we only fetch schema once per base
  const byBase = new Map<string, Set<string>>();
  for (const p of pairs) {
    const [b, t] = p.split("/");
    if (!byBase.has(b)) byBase.set(b, new Set());
    byBase.get(b)!.add(t);
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const [baseId, tableIds] of byBase) {
    let schema;
    try {
      schema = await listBaseSchema(baseId);
    } catch (e) {
      console.error(`✗ ${baseId}: failed to fetch schema — ${(e as Error).message}`);
      failed += tableIds.size;
      continue;
    }

    for (const tableId of tableIds) {
      const table = schema.find((t) => t.id === tableId);
      if (!table) {
        console.log(`  ? ${baseId}/${tableId}: table not found in schema (skipping)`);
        skipped++;
        continue;
      }
      const exists = table.fields.some((f) => f.name === FIELD_NAME);
      const tableLabel = `${baseId}/${tableId} (${table.name})`;
      if (exists) {
        console.log(`  = ${tableLabel}: already has "${FIELD_NAME}" — skip`);
        skipped++;
        continue;
      }

      if (!apply) {
        console.log(`  + ${tableLabel}: WOULD CREATE "${FIELD_NAME}" (${FIELD_TYPE})`);
        created++;
        continue;
      }

      const result = await addField(baseId, tableId);
      if (result.ok) {
        console.log(`  ✓ ${tableLabel}: created`);
        created++;
      } else {
        console.error(`  ✗ ${tableLabel}: ${result.status} ${result.body}`);
        failed++;
      }

      // gentle pacing for Airtable Meta API
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log("");
  console.log(`Summary: ${created} ${apply ? "created" : "would create"}, ${skipped} skipped, ${failed} failed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
