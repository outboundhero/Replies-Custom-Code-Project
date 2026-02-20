/**
 * Patch company codes — run with: npx tsx scripts/patch-company-codes.ts
 * - Fixes wrong patterns (PC, SH)
 * - Adds 16 missing codes from the CSV
 * Does NOT clear the table — only updates/inserts.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";

config({ path: ".env.local" });

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  // ── 1. Fix wrong patterns ──────────────────────────────────────────────────

  // PC: CSV says prioritycleaningllc.com, we had prioritycleaninginc.com
  await db.execute({
    sql: "UPDATE company_codes SET pattern = ? WHERE code = ?",
    args: ["prioritycleaningllc\\.com", "PC"],
  });
  console.log("Fixed PC → prioritycleaningllc.com");

  // SH: CSV says scrubheroesarizona.com, we had scrubheroes-az.com
  await db.execute({
    sql: "UPDATE company_codes SET pattern = ? WHERE code = ?",
    args: ["scrubheroesarizona\\.com|scrubheroes-az\\.com", "SH"],
  });
  console.log("Fixed SH → scrubheroesarizona.com|scrubheroes-az.com");

  // BCSA: more specific — broomday.com (CSV shows broomday.com/texas but domain is enough)
  await db.execute({
    sql: "UPDATE company_codes SET pattern = ? WHERE code = ?",
    args: ["broomday\\.com", "BCSA"],
  });
  console.log("Fixed BCSA → broomday.com");

  // IM: CSV says imc.cleaning — make pattern cover both imc.cleaning and original imc keyword
  await db.execute({
    sql: "UPDATE company_codes SET pattern = ? WHERE code = ?",
    args: ["imc\\.cleaning|\\bimc\\b", "IM"],
  });
  console.log("Fixed IM → imc.cleaning|\\bimc\\b");

  // ── 2. Add missing codes ───────────────────────────────────────────────────
  // New codes go in at priority 0 (lowest) so they don't disturb existing priority order.
  // The existing codes already handle specificity; these fill gaps.

  const missing: Array<{ code: string; pattern: string }> = [
    // DBS variants — same domain as DBSM (dbsbuildingsolutions.com).
    // Ambiguous by redirect alone; adding so they appear in the table.
    { code: "DBSA",   pattern: "dbsbuildingsolutions\\.com" },
    { code: "DBSF",   pattern: "dbsbuildingsolutions\\.com" },
    { code: "DBSNJ",  pattern: "dbsbuildingsolutions\\.com" },

    // Jan-Pro new franchises
    { code: "JPM",    pattern: "jan-pro\\.com\\/memphis" },
    { code: "JPCA",   pattern: "jan-pro\\.com\\/centralalabama" },
    { code: "JPNYC",  pattern: "jan-pro\\.com\\/nyc" },
    { code: "JPHO",   pattern: "jan-pro\\.com\\/houston" },
    { code: "JPD",    pattern: "jan-pro\\.com\\/delmarva" },
    { code: "JPCOH",  pattern: "jan-pro\\.com\\/columbusoh" },
    { code: "JPWPB",  pattern: "jan-pro\\.com\\/west-palm-beach" },
    { code: "JPSAN",  pattern: "jan-pro\\.com\\/sanantonio" },

    // Other new clients
    { code: "FBS",    pattern: "freedombuildingservices\\.com" },
    { code: "WHN",    pattern: "windowhero\\.com" },
    { code: "CCGSTL", pattern: "corporatecleaninggroup\\.com" },
    { code: "CFS",    pattern: "centralfacility\\.com" },
    { code: "CCGW",   pattern: "ccgwichita\\.com" },
  ];

  for (const { code, pattern } of missing) {
    // Only insert if not already present
    const existing = await db.execute({
      sql: "SELECT id FROM company_codes WHERE code = ?",
      args: [code],
    });
    if (existing.rows.length === 0) {
      await db.execute({
        sql: "INSERT INTO company_codes (code, pattern, priority) VALUES (?, ?, 0)",
        args: [code, pattern],
      });
      console.log(`Added ${code} → ${pattern}`);
    } else {
      console.log(`Skipped ${code} (already exists)`);
    }
  }

  // ── 3. Summary ─────────────────────────────────────────────────────────────
  const total = await db.execute("SELECT COUNT(*) as n FROM company_codes");
  console.log(`\nDone. Total company codes in DB: ${total.rows[0].n}`);

  console.log("\n⚠ NOTES:");
  console.log("  DBSA/DBSF/DBSNJ share the same website as DBSM (dbsbuildingsolutions.com).");
  console.log("  Untracked emails from that sender domain will match whichever DBS code");
  console.log("  has the highest priority. These can only be truly distinguished via campaign tags.");
  console.log("");
  console.log("  JPET (knoxville) and JPETC (chattanooga) — CSV shows both as chattanooga.");
  console.log("  JPET is kept as jan-pro.com/knoxville. Update manually if it should be chattanooga.");
}

main().catch(console.error);
