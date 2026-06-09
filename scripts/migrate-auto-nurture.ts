/**
 * One-shot migration: add the auto-nurture columns to client_config.
 *
 * Idempotent — each ALTER is wrapped in a try/catch so re-running it
 * after the columns already exist won't error out. Safe to run multiple
 * times.
 *
 * Run:  npx tsx scripts/migrate-auto-nurture.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function tryAdd(sql: string) {
  try {
    await db.execute(sql);
    console.log(`  ✓ ${sql}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("duplicate column name") || msg.includes("already exists")) {
      console.log(`  ⏭  column already exists (skipped) — ${sql}`);
    } else {
      console.error(`  ✗ ${sql}\n     ${msg}`);
      throw e;
    }
  }
}

async function main() {
  console.log("Migrating client_config (auto-nurture columns)…");
  await tryAdd("ALTER TABLE client_config ADD COLUMN auto_nurture_enabled INTEGER NOT NULL DEFAULT 0");
  await tryAdd("ALTER TABLE client_config ADD COLUMN auto_nurture_enabled_at TEXT");
  await tryAdd("ALTER TABLE client_config ADD COLUMN auto_nurture_last_run_at TEXT");

  // Verify
  const cols = await db.execute("PRAGMA table_info(client_config)");
  const names = cols.rows.map((r) => r.name);
  const need = ["auto_nurture_enabled", "auto_nurture_enabled_at", "auto_nurture_last_run_at"];
  const missing = need.filter((n) => !names.includes(n));
  if (missing.length === 0) {
    console.log("\nAll 3 columns present. Done.");
  } else {
    console.error("\n⚠️  Missing columns after migration:", missing);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
