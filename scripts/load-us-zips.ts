/**
 * Load the US ZIP reference table (Turso `us_zip`) used by the ZIP audit to
 * verify every ZIP the resolver produces: it must exist, and its city/state must
 * agree with the evidence. Source: GeoNames postal codes (CC BY 4.0,
 * https://download.geonames.org/export/zip/) — one row per US ZIP with place
 * name, state, county and coordinates.
 *
 * Run (safe to re-run; replaces the table contents):
 *   npx tsx -r dotenv/config scripts/load-us-zips.ts dotenv_config_path=.env.local
 */
import { execSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import db from "@/lib/db";

(async () => {
  const dir = mkdtempSync(join(tmpdir(), "us-zips-"));
  execSync(`curl -sSL -o ${dir}/US.zip https://download.geonames.org/export/zip/US.zip && unzip -o -q ${dir}/US.zip -d ${dir}`);
  const rows = readFileSync(join(dir, "US.txt"), "utf8").split("\n").filter(Boolean).map((line) => {
    // country, zip, place, state name, state code, county, county code, -, -, lat, lng, accuracy
    const f = line.split("\t");
    return { zip: f[1], city: f[2], state: f[4], county: f[5] || null, lat: Number(f[9]), lng: Number(f[10]) };
  }).filter((r) => /^\d{5}$/.test(r.zip) && r.state);

  await db.execute(`CREATE TABLE IF NOT EXISTS us_zip (
    zip TEXT PRIMARY KEY, city TEXT NOT NULL, state TEXT NOT NULL, county TEXT, lat REAL, lng REAL
  )`);
  await db.execute("CREATE INDEX IF NOT EXISTS us_zip_city_state ON us_zip (state, city)");
  await db.execute("DELETE FROM us_zip");
  for (let i = 0; i < rows.length; i += 500) {
    await db.batch(rows.slice(i, i + 500).map((r) => ({
      sql: "INSERT OR REPLACE INTO us_zip (zip, city, state, county, lat, lng) VALUES (?, ?, ?, ?, ?, ?)",
      args: [r.zip, r.city, r.state, r.county, r.lat, r.lng],
    })), "write");
  }
  const n = await db.execute("SELECT COUNT(*) n FROM us_zip");
  console.log(`us_zip loaded: ${(n.rows[0] as unknown as { n: number }).n} ZIPs`);
})();
