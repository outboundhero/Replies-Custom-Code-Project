/**
 * Seed per-client GoHighLevel credentials into Turso `client_config`.
 * Credentials are passed as CLI args (never hard-coded here / committed).
 *
 * Usage:
 *   npx tsx scripts/seed-ghl-config.ts <TAG> <ghl_api_key> <ghl_location_id> [<TAG> <key> <loc> ...]
 *
 * Example:
 *   npx tsx scripts/seed-ghl-config.ts JPPS pit-xxxx kP8Pcr4W6i7Hm8lkLbjo JPKC pit-yyyy 5Injzd6nIxKnercBMbS8
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import db, { initializeDatabase } from "@/lib/db";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length % 3 !== 0) {
    console.error("Usage: npx tsx scripts/seed-ghl-config.ts <TAG> <ghl_api_key> <ghl_location_id> [...]");
    process.exit(1);
  }
  await initializeDatabase(); // ensure ghl_api_key / ghl_location_id columns exist
  for (let i = 0; i < args.length; i += 3) {
    const tag = args[i].toUpperCase();
    const key = args[i + 1];
    const loc = args[i + 2];
    await db.execute({ sql: "INSERT OR IGNORE INTO client_config (client_tag) VALUES (?)", args: [tag] });
    await db.execute({
      sql: "UPDATE client_config SET ghl_api_key = ?, ghl_location_id = ?, updated_at = CURRENT_TIMESTAMP WHERE UPPER(client_tag) = UPPER(?)",
      args: [key, loc, tag],
    });
    const res = await db.execute({
      sql: "SELECT ghl_location_id, length(ghl_api_key) AS keylen FROM client_config WHERE UPPER(client_tag) = UPPER(?)",
      args: [tag],
    });
    const row = res.rows[0];
    console.log(`✓ ${tag}: location_id=${row?.ghl_location_id} · api_key_len=${row?.keylen}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("FATAL", e); process.exit(1); });
