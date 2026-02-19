/**
 * Update company codes script — run with: npx tsx scripts/update-company-codes.ts
 * Clears existing company_codes and inserts all codes from the Clay formula in priority order.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";

config({ path: ".env.local" });

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Company codes in priority order (index 0 = highest priority, matched first).
// Patterns are stored as regex strings used with new RegExp(pattern).test(blob).
// The blob is: `${senderDomain} ${redirectLink} ${emailBody}`.toLowerCase()
//
// Convention: use \. for literal dot, \/ for literal slash.
// Pipes (|) separate alternatives for the same code.
const companyCodes: Array<{ code: string; pattern: string }> = [
  // ── Regex block (complex multi-pattern entries, highest priority) ──
  { code: "AC",    pattern: "analyzecorp\\.com|analyze360|analyzecorp" },
  { code: "DM4PM", pattern: "dm4pm\\.com|dm4pm" },
  { code: "SC",    pattern: "shockwavecenters\\.com" },
  { code: "HW",    pattern: "hamiltonwise\\.com" },
  { code: "OM",    pattern: "orthomarketing\\.com" },
  { code: "BTSB",  pattern: "behindthescenesbroker|btsb|ashlandauction|trybstsb\\.com" },
  { code: "OH",    pattern: "outboundhero|spencersellstech\\.com" },
  { code: "BBS",   pattern: "utah|blumontservices\\.com" },
  { code: "EMNV",  pattern: "enviro-master\\.com|northernvirginia|northernvirginia\\.localcommercialcleaning\\.co" },
  { code: "HS",    pattern: "santaclara|hygeiaservices\\.com|siliconvalleyjanitorial|siliconvalley" },
  { code: "FSD",   pattern: "sandiego\\.localcommercialcleaning\\.co|sandiego|forte-sandiego\\.com" },
  { code: "CCO",   pattern: "orlando\\.localcommercialcleaning\\.co|orlando" },
  // CWSV must be before CWSJ — "gocitywide.com/siliconvalley" is more specific
  { code: "CWSV",  pattern: "gocitywide\\.com\\/siliconvalley" },
  { code: "CWSJ",  pattern: "sanjose|gocitywide\\.com" },
  { code: "BAJFI", pattern: "bajfi\\.com|sanfrancisco|sanfrancisco\\.localcommercialcleaning\\.co" },
  { code: "TCS",   pattern: "tarylen\\.com|longmont" },
  { code: "SI",    pattern: "satininsurance\\.com|satin" },
  { code: "MGE",   pattern: "mgeonline" },
  { code: "ABM",   pattern: "ahlersbuildingmaintenance" },
  { code: "CHP",   pattern: "cleanhorizonpro" },
  { code: "IM",    pattern: "imc" },
  { code: "ACAD",  pattern: "allcareallday" },
  { code: "CI",    pattern: "cappstone" },
  { code: "BCSA",  pattern: "broomday" },
  { code: "HC",    pattern: "hurricanecleaning" },
  { code: "FACS",  pattern: "freshestaircleaningservice" },
  { code: "CC",    pattern: "colonialcleaning" },
  { code: "CCH",   pattern: "cleancozyhome\\.com" },
  { code: "BHS",   pattern: "nashvillebhs\\.com" },
  { code: "TBC",   pattern: "twobrotherschristmas\\.com" },
  { code: "CE",    pattern: "crispenvironments\\.com" },

  // ── Includes block (single-domain entries, lower priority) ──
  { code: "SFS",   pattern: "summitfacilitysolutions\\.com" },
  { code: "MM",    pattern: "mopmafia\\.com" },
  { code: "CCUSA", pattern: "corecleanusa\\.com" },
  { code: "FCBM",  pattern: "firstchoicesfl\\.com" },
  { code: "MTG",   pattern: "maidtoglow\\.com" },
  { code: "SBC",   pattern: "shinebrightcleaning\\.com" },
  { code: "JV",    pattern: "janivolt\\.com" },
  { code: "CCSI",  pattern: "corporatecleaningpdx\\.com" },
  // Jan-Pro paths — most specific first (avoid matching wrong franchise)
  { code: "JPCHI", pattern: "jan-pro\\.com\\/chicago" },
  { code: "JPCIN", pattern: "jan-pro\\.com\\/cincinnati" },
  { code: "JPCNJ", pattern: "jan-pro\\.com\\/centralnj" },
  { code: "JPCI",  pattern: "jan-pro\\.com\\/indiana" },
  { code: "JPNNJ", pattern: "jan-pro\\.com\\/northernnewjersey" },
  { code: "JPK",   pattern: "jan-pro\\.com\\/kentucky" },
  { code: "JPDFW", pattern: "jan-pro\\.com\\/dfw" },
  { code: "JPSD",  pattern: "jan-pro\\.com\\/sandiego" },
  { code: "JPET",  pattern: "jan-pro\\.com\\/knoxville" },
  { code: "JPETC", pattern: "jan-pro\\.com\\/chattanooga" },
  { code: "JPH",   pattern: "jan-pro\\.com\\/huntsville" },
  { code: "JPLV",  pattern: "jan-pro\\.com\\/lasvegas" },
  { code: "JPC",   pattern: "jan-pro\\.com\\/charlotte" },
  { code: "JPP",   pattern: "jan-pro\\.com\\/philadelphia" },
  { code: "JPCKA", pattern: "jan-pro\\.com\\/columbusga" },
  { code: "JPGW",  pattern: "jan-pro\\.com\\/wichita" },
  { code: "JPWM",  pattern: "jan-pro\\.com\\/westmichigan" },
  { code: "JPU",   pattern: "jan-pro\\.com\\/utah" },
  { code: "JPOSW", pattern: "jan-pro\\.com\\/portland" },
  { code: "JPSWM", pattern: "jan-pro\\.com\\/ozarks" },
  { code: "JPAR",  pattern: "jan-pro\\.com\\/arkansas" },
  { code: "JPS",   pattern: "jan-pro\\.com\\/sacramento" },
  { code: "JPNEGA",pattern: "jan-pro\\.com\\/augusta" },
  { code: "JPCO",  pattern: "jan-pro\\.com\\/denver" },
  { code: "JPSNE", pattern: "jan-pro\\.com\\/rhodeisland" },
  { code: "JPT",   pattern: "jan-pro\\.com\\/triad" },
  { code: "JPNW",  pattern: "jan-pro\\.com\\/spokane" },
  { code: "JPNEP", pattern: "jan-pro\\.com\\/northeasternpa" },
  { code: "JPNH",  pattern: "jan-pro\\.com\\/ne" },
  { code: "JPOKC", pattern: "jan-pro\\.com\\/oklahomacity" },
  // Other entries (continues includes block)
  { code: "PPW",   pattern: "prwash\\.com" },
  { code: "RFS",   pattern: "rainierfacilitysolutions\\.com" },
  { code: "CAPW",  pattern: "curbappealpowerwash\\.com" },
  { code: "IJSD",  pattern: "ijsdallas\\.com" },
  { code: "Q",     pattern: "qleen\\.com|zillaclean\\.com" },
  { code: "MFS",   pattern: "macsjanitorial\\.com" },
  { code: "TGS",   pattern: "titanglobalsol\\.com" },
  { code: "SCS",   pattern: "santanascleaningservice\\.com" },
  { code: "YBS",   pattern: "youngbuildingsolutions\\.com" },
  { code: "YGC",   pattern: "auroraopx\\.com" },
  { code: "CCS",   pattern: "citicleanservices\\.com" },
  { code: "NCC",   pattern: "noblecleanco\\.com|noblecommercialcleaningservices\\.com" },
  { code: "EVC",   pattern: "emeraldvalleyclean\\.com" },
  { code: "FCS",   pattern: "freedomcleaningsolutions\\.com" },
  { code: "DDCC",  pattern: "doubledutyclean\\.com" },
  { code: "QP",    pattern: "skytabpro\\.io" },
  { code: "CPGH",  pattern: "cleaningprogroup\\.com" },
  { code: "ECCS",  pattern: "ecocarecleaningservices\\.com" },
  { code: "BG",    pattern: "berlimsgroup\\.com" },
  { code: "SG",    pattern: "spotlessgroupusa\\.com" },
  { code: "RPC",   pattern: "refreshprofessionalcleaning\\.com" },
  { code: "PC",    pattern: "prioritycleaninginc\\.com" },
  { code: "RSC",   pattern: "rocketsciencecleaning\\.com" },
  { code: "MPD",   pattern: "maidpro\\.com\\/denver" },
  { code: "CSCC",  pattern: "civicsparkcleaning\\.com" },
  { code: "ESJ",   pattern: "ecosourcejanitorial\\.com" },
  { code: "CCGC",  pattern: "ccgcoastalsc\\.com" },
  { code: "CPGA",  pattern: "gmaintenance\\.com" },
  { code: "DBSM",  pattern: "dbsbuildingsolutions\\.com" },
  { code: "CTS",   pattern: "cleantechnologyservices\\.com" },
  { code: "FLFMS", pattern: "freshlookfacilitymaintenanceservice\\.com" },
  { code: "ECG",   pattern: "evergreencleaninggroup\\.com" },
  { code: "DO",    pattern: "desertoasiscleaners\\.com" },
  { code: "SH",    pattern: "scrubheroes-az\\.com" },
  { code: "VGM",   pattern: "vanguardcleaningminn\\.com" },
  { code: "RTWJ",  pattern: "rtwjanitorial\\.com" },
  { code: "KLCS",  pattern: "knlcleaning\\.com" },
  { code: "GJEC",  pattern: "elitecleaningcolorado\\.com" },
  { code: "PCL",   pattern: "premiercleaningsf\\.com" },
  { code: "GCJ",   pattern: "greencleanjanitorial\\.com" },
  { code: "AFS",   pattern: "absolutefsinc\\.com" },
  { code: "NBM",   pattern: "nwbminc\\.com" },
  { code: "XTC",   pattern: "xcleanlv\\.com" },
  { code: "CS",    pattern: "thecleanstart\\.com" },
  { code: "PCC",   pattern: "phxcommercialcleaning\\.com" },
  { code: "MS",    pattern: "metropointservices\\.com" },
  // Catch-all: localcommercialcleaning.co must be LAST (after all specific subdomain variants)
  { code: "PP",    pattern: "localcommercialcleaning\\.co" },
];

async function updateCompanyCodes() {
  console.log(`Updating ${companyCodes.length} company codes...`);

  // Clear existing
  await db.execute("DELETE FROM company_codes");
  console.log("  Cleared existing company codes.");

  // Insert new codes with priority = (total - index), so index 0 gets highest priority
  const total = companyCodes.length;
  for (let i = 0; i < companyCodes.length; i++) {
    const { code, pattern } = companyCodes[i];
    const priority = total - i; // e.g. 117, 116, ..., 1
    await db.execute({
      sql: "INSERT INTO company_codes (code, pattern, priority) VALUES (?, ?, ?)",
      args: [code, pattern, priority],
    });
  }

  console.log(`  Inserted ${companyCodes.length} company codes.`);
  console.log("\nDone! Company codes updated successfully.");
  console.log("\nSample (first 5, highest priority):");
  const result = await db.execute("SELECT code, pattern, priority FROM company_codes ORDER BY priority DESC LIMIT 5");
  for (const row of result.rows) {
    console.log(`  [${row.priority}] ${row.code}: ${row.pattern}`);
  }
}

updateCompanyCodes().catch(console.error);
