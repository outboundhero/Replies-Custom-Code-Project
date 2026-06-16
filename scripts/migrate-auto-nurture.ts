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
  // Opt-out model: a client is auto-nurtured by DEFAULT (disabled=0) unless
  // explicitly turned off. This flag is unambiguous (unlike auto_nurture_enabled
  // whose 0 default can't be told apart from "explicitly off").
  await tryAdd("ALTER TABLE client_config ADD COLUMN auto_nurture_disabled INTEGER NOT NULL DEFAULT 0");
  await tryAdd("ALTER TABLE client_config ADD COLUMN auto_nurture_disabled_at TEXT");

  // Optional conservative rollout: --seed-disabled-from-legacy keeps clients
  // that were opt-in-OFF (auto_nurture_enabled=0) OFF under the new opt-out
  // model, so going live doesn't switch on routing for everyone at once.
  if (process.argv.includes("--seed-disabled-from-legacy")) {
    const r = await db.execute("UPDATE client_config SET auto_nurture_disabled = 1, auto_nurture_disabled_at = datetime('now') WHERE COALESCE(auto_nurture_enabled,0) = 0");
    console.log(`  seeded auto_nurture_disabled=1 for ${r.rowsAffected} previously-off clients`);
  }

  // Verify
  const cols = await db.execute("PRAGMA table_info(client_config)");
  const names = cols.rows.map((r) => r.name);
  const need = ["auto_nurture_enabled", "auto_nurture_enabled_at", "auto_nurture_last_run_at", "auto_nurture_disabled", "auto_nurture_disabled_at"];
  const missing = need.filter((n) => !names.includes(n));
  if (missing.length === 0) {
    console.log("\nAll 3 columns present. Done.");
  } else {
    console.error("\n⚠️  Missing columns after migration:", missing);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
