/**
 * One-off: list every Airtable base + Leads/Meeting-Ready table the
 * Reply Router writes to. Used before bulk-adding the "Bison Instance"
 * field so we know exactly which (base, table) pairs need it.
 */
import db from "../lib/db";

interface Section {
  name: string;
  airtable_base_id: string;
  airtable_table_id: string;
  meeting_ready_table_id: string | null;
}

async function main() {
  const sections = await db.execute(
    "SELECT name, airtable_base_id, airtable_table_id, meeting_ready_table_id FROM sections ORDER BY name",
  );
  const untracked = await db.execute(
    "SELECT airtable_base_id, airtable_table_id, meeting_ready_table_id FROM untracked_config WHERE id = 1",
  );

  console.log("─── TRACKED (sections) ───");
  for (const s of sections.rows as unknown as Section[]) {
    console.log(`  ${s.name.padEnd(30)} base=${s.airtable_base_id}  leads=${s.airtable_table_id}  meeting_ready=${s.meeting_ready_table_id}`);
  }
  console.log("");
  console.log("─── UNTRACKED ───");
  for (const u of untracked.rows as unknown as Section[]) {
    console.log(`  base=${u.airtable_base_id}  leads=${u.airtable_table_id}  meeting_ready=${u.meeting_ready_table_id}`);
  }

  // Distinct (base, table) pairs
  const pairs = new Set<string>();
  for (const s of sections.rows as unknown as Section[]) {
    pairs.add(`${s.airtable_base_id}/${s.airtable_table_id}`);
    if (s.meeting_ready_table_id) pairs.add(`${s.airtable_base_id}/${s.meeting_ready_table_id}`);
  }
  for (const u of untracked.rows as unknown as Section[]) {
    pairs.add(`${u.airtable_base_id}/${u.airtable_table_id}`);
    if (u.meeting_ready_table_id) pairs.add(`${u.airtable_base_id}/${u.meeting_ready_table_id}`);
  }
  console.log("");
  console.log(`─── ${pairs.size} distinct (base, table) pairs to update ───`);
  for (const p of [...pairs].sort()) console.log(`  ${p}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
