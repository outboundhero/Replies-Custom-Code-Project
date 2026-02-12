/**
 * Seed script — run with: npx tsx scripts/seed.ts
 * Populates Turso DB with all current sections, tags, company codes, bounce filters, and Clay URLs.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";

config({ path: ".env.local" });

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function seed() {
  console.log("Initializing schema...");

  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      airtable_base_id TEXT NOT NULL,
      airtable_table_id TEXT NOT NULL DEFAULT 'tbl1BnpnsUBrBGeuy',
      meeting_ready_table_id TEXT DEFAULT 'tblmBx4BWbmeJMNN1',
      clay_webhook_url_tracked TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS client_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag TEXT NOT NULL UNIQUE,
      section_id INTEGER NOT NULL,
      FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS untracked_config (
      id INTEGER PRIMARY KEY,
      airtable_base_id TEXT NOT NULL,
      airtable_table_id TEXT NOT NULL DEFAULT 'tbl1BnpnsUBrBGeuy',
      meeting_ready_table_id TEXT DEFAULT 'tblmBx4BWbmeJMNN1',
      clay_webhook_url TEXT
    );

    CREATE TABLE IF NOT EXISTS company_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      pattern TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bounce_filters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field TEXT NOT NULL,
      value TEXT NOT NULL,
      match_type TEXT NOT NULL DEFAULT 'notContains'
    );

    CREATE TABLE IF NOT EXISTS error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      workflow TEXT NOT NULL,
      stage TEXT NOT NULL,
      message TEXT NOT NULL,
      payload TEXT
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      workflow TEXT NOT NULL,
      client_tag TEXT,
      section_name TEXT,
      lead_email TEXT,
      action TEXT NOT NULL,
      details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_client_tags_tag ON client_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_company_codes_priority ON company_codes(priority DESC);
    CREATE INDEX IF NOT EXISTS idx_error_log_timestamp ON error_log(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON activity_log(timestamp DESC);
  `);

  // ── Clear existing data ──
  await db.executeMultiple(`
    DELETE FROM client_tags;
    DELETE FROM sections;
    DELETE FROM untracked_config;
    DELETE FROM company_codes;
    DELETE FROM bounce_filters;
  `);

  // ── Sections (7 Airtable bases) ──
  const sections = [
    {
      name: "Section 1",
      airtable_base_id: "appqZiSdsbeBCuHEp",
      clay_webhook_url_tracked: "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-100cb599-20aa-49c8-82b5-2d5ce67d51d9",
      tags: ["OH","AC","DM4PM","BTSB","SI","BAJFI","SC","CWSJ","HS","BBS","ABM","FSD","IM","BHS","CI","SRO"],
    },
    {
      name: "Section 2",
      airtable_base_id: "appGsk8TNtjwVmZZ4",
      clay_webhook_url_tracked: "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-b6fda8a3-a3be-4135-b401-f45db2d6fbec",
      tags: ["PWSTC","CE","TBC","SFS","JPC","FCBM","MTG","JV","SBC","CCSI","GFS","PPW","CAPW","RFS","JPCI","IJSD","JPNNJ","JPP","SCM","TWC","SSP","JMCC","JPC&A","Q"],
    },
    {
      name: "Section 3",
      airtable_base_id: "appQ8xxARCGmcft6E",
      clay_webhook_url_tracked: "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-988a17f5-ba14-45f0-bcd5-69fa71c94586",
      tags: ["SCS","YBS","TGS","JPDFW","JPK","MFS","CCS","JPSD","QP","PP","YGC","DDCC","NCC","PPC","DBSM","BG","DBSA","ECCS","CPGH","CPGA","FCS","EVC","JPET"],
    },
    {
      name: "Section 4",
      airtable_base_id: "appYWttC5gLjV3kso",
      clay_webhook_url_tracked: "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-da3e0799-e451-4f64-9897-a6dbccb397ea",
      tags: ["SG","JPH","MPD","CSCC","RSC","JPLV","PC","TSC","FLFMS","JPOSW","JPU","JPAR","JPUNY","JPCW","CCGC","ECG","JPCNJ","JPWM","DBSNJ","DBSF","JPSWM","JPCHI","JPCIN","DO","BCSA","JPGW"],
    },
    {
      name: "Section 5",
      airtable_base_id: "appPmEI39HJfkFXjv",
      clay_webhook_url_tracked: "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-b9d0d70f-b434-49e7-b930-addca4f00634",
      tags: ["ESJ"],
    },
    {
      name: "Section 6",
      airtable_base_id: "appRr92qMRKP5YCUw",
      clay_webhook_url_tracked: "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-6b7004f2-498f-4e38-9f68-9538987fcf69",
      tags: ["CTS","JPS","JPCA","JPNEGA","JPCO","JPSNE","JPNW","SH","CWSV","VGM","RTWJ","K&LCS","GJEC","PCL","JPM","JPNEP","GCJ","JPNYC","JPHO","JPETC","NBM","CS"],
    },
    {
      name: "Section 7",
      airtable_base_id: "appL5AaH8VcP2yWoQ",
      clay_webhook_url_tracked: "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-365a47ae-3981-4291-8622-95b15a0aa356",
      tags: ["XTC","AFS","JPOKC","PCC","JPNH","MS","JPT","FBS","WHN"],
    },
  ];

  console.log("Seeding sections and tags...");
  for (const section of sections) {
    const result = await db.execute({
      sql: "INSERT INTO sections (name, airtable_base_id, clay_webhook_url_tracked) VALUES (?, ?, ?)",
      args: [section.name, section.airtable_base_id, section.clay_webhook_url_tracked],
    });
    const sectionId = Number(result.lastInsertRowid);

    for (const tag of section.tags) {
      await db.execute({
        sql: "INSERT INTO client_tags (tag, section_id) VALUES (?, ?)",
        args: [tag, sectionId],
      });
    }
    console.log(`  ${section.name}: ${section.tags.length} tags`);
  }

  // ── Untracked Config (singleton) ──
  console.log("Seeding untracked config...");
  await db.execute({
    sql: "INSERT INTO untracked_config (id, airtable_base_id, clay_webhook_url) VALUES (1, ?, ?)",
    args: [
      "appqZiSdsbeBCuHEp",
      "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-100cb599-20aa-49c8-82b5-2d5ce67d51d9",
    ],
  });

  // ── Company Codes (untracked domain→code regex patterns) ──
  console.log("Seeding company codes...");
  const companyCodes: Array<{ code: string; pattern: string; priority: number }> = [
    { code: "AC", pattern: "analyzecorp\\.com|analyze360|analyzecorp", priority: 100 },
    { code: "DM4PM", pattern: "dm4pm\\.com|dm4pm", priority: 99 },
    { code: "SC", pattern: "shockwavecenters\\.com", priority: 98 },
    { code: "HW", pattern: "hamiltonwise\\.com", priority: 97 },
    { code: "OM", pattern: "orthomarketing\\.com", priority: 96 },
    { code: "BTSB", pattern: "behindthescenesbroker|btsb|ashlandauction|trybstsb\\.com", priority: 95 },
    { code: "OH", pattern: "outboundhero|spencersellstech\\.com", priority: 94 },
    { code: "BBS", pattern: "utah|blumontservices\\.com", priority: 93 },
    { code: "EMNV", pattern: "enviro-master\\.com|northernvirginia|northernvirginia\\.localcommercialcleaning\\.co", priority: 92 },
    { code: "HS", pattern: "santaclara|hygeiaservices\\.com|siliconvalleyjanitorial|siliconvalley", priority: 91 },
    { code: "FSD", pattern: "sandiego\\.localcommercialcleaning\\.co|sandiego|forte-sandiego\\.com", priority: 90 },
    { code: "CCO", pattern: "orlando\\.localcommercialcleaning\\.co|orlando", priority: 89 },
    { code: "CWSJ", pattern: "sanjose|gocitywide\\.com", priority: 88 },
    { code: "BAJFI", pattern: "bajfi\\.com|sanfrancisco|sanfrancisco\\.localcommercialcleaning\\.co", priority: 87 },
    { code: "TCS", pattern: "tarylen\\.com|longmont", priority: 86 },
    { code: "SI", pattern: "satininsurance\\.com|satin", priority: 85 },
    { code: "MGE", pattern: "mgeonline", priority: 84 },
    { code: "ABM", pattern: "ahlersbuildingmaintenance", priority: 83 },
    { code: "CHP", pattern: "cleanhorizonpro", priority: 82 },
    { code: "IM", pattern: "imc", priority: 81 },
    { code: "ACAD", pattern: "allcareallday", priority: 80 },
    { code: "CI", pattern: "cappstone", priority: 79 },
    { code: "BCS", pattern: "broomday", priority: 78 },
    { code: "HC", pattern: "hurricanecleaning", priority: 77 },
    { code: "FACS", pattern: "freshestaircleaningservice", priority: 76 },
    { code: "CC", pattern: "colonialcleaning", priority: 75 },
    { code: "CCH", pattern: "cleancozyhome\\.com", priority: 74 },
    { code: "BHS", pattern: "nashvillebhs\\.com", priority: 73 },
    { code: "TBC", pattern: "twobrotherschristmas\\.com", priority: 72 },
    { code: "CE", pattern: "crispenvironments\\.com", priority: 71 },
    { code: "SFS", pattern: "summitfacilitysolutions\\.com", priority: 70 },
    { code: "MM", pattern: "mopmafia\\.com", priority: 69 },
    { code: "CCUSA", pattern: "corecleanusa\\.com", priority: 68 },
    { code: "FCBM", pattern: "firstchoicesfl\\.com", priority: 67 },
    { code: "MTG", pattern: "maidtoglow\\.com", priority: 66 },
    { code: "SBC", pattern: "shinebrightcleaning\\.com", priority: 65 },
    { code: "JV", pattern: "janivolt\\.com", priority: 64 },
    { code: "CCSI", pattern: "corporatecleaningpdx\\.com", priority: 63 },
    { code: "JPCI", pattern: "jan-pro\\.com\\/indiana", priority: 62 },
    { code: "PPW", pattern: "prwash\\.com", priority: 61 },
    { code: "RFS", pattern: "rainierfacilitysolutions\\.com", priority: 60 },
    { code: "CAPW", pattern: "curbappealpowerwash\\.com", priority: 59 },
    { code: "IJSD", pattern: "ijsdallas\\.com", priority: 58 },
    { code: "JPNNJ", pattern: "jan-pro\\.com\\/northernnewjersey", priority: 57 },
    { code: "Q", pattern: "qleen\\.com|zillaclean\\.com", priority: 56 },
    { code: "MFS", pattern: "macsjanitorial\\.com", priority: 55 },
    { code: "JPK", pattern: "jan-pro\\.com\\/kentucky", priority: 54 },
    { code: "JPDFW", pattern: "jan-pro\\.com\\/dfw", priority: 53 },
    { code: "TGS", pattern: "titanglobalsol\\.com", priority: 52 },
    { code: "SCS", pattern: "santanascleaningservice\\.com", priority: 51 },
    { code: "YBS", pattern: "youngbuildingsolutions\\.com", priority: 50 },
    { code: "YGC", pattern: "auroraopx\\.com", priority: 49 },
    { code: "PP", pattern: "localcommercialcleaning\\.co", priority: 48 },
    { code: "JPSD", pattern: "jan-pro\\.com\\/sandiego", priority: 47 },
    { code: "CCS", pattern: "citicleanservices\\.com", priority: 46 },
    { code: "NCC", pattern: "noblecleanco\\.com|noblecommercialcleaningservices\\.com", priority: 45 },
    { code: "EVC", pattern: "emeraldvalleyclean\\.com", priority: 44 },
    { code: "FCS", pattern: "freedomcleaningsolutions\\.com", priority: 43 },
    { code: "DDCC", pattern: "doubledutyclean\\.com", priority: 42 },
    { code: "QP", pattern: "skytabpro\\.io", priority: 41 },
    { code: "CPGH", pattern: "cleaningprogroup\\.com", priority: 40 },
  ];

  for (const cc of companyCodes) {
    await db.execute({
      sql: "INSERT INTO company_codes (code, pattern, priority) VALUES (?, ?, ?)",
      args: [cc.code, cc.pattern, cc.priority],
    });
  }
  console.log(`  ${companyCodes.length} company codes`);

  // ── Bounce Filters (40+ conditions for untracked) ──
  console.log("Seeding bounce filters...");
  const bounceFilters: Array<{ field: string; value: string; match_type: string }> = [
    // Filter node 1
    { field: "subject", value: "Undeliverable", match_type: "notEquals" },
    { field: "from_name", value: "Mail Delivery System", match_type: "notContains" },
    { field: "from_name", value: "Mail Delivery Subsystem", match_type: "notEquals" },
    { field: "from_name", value: "Microsoft Outlook", match_type: "notEquals" },
    { field: "subject", value: "Report domain", match_type: "notContains" },
    { field: "from_name", value: "DMARC Report", match_type: "notEquals" },
    { field: "from_email", value: "lincolnwastesolutionsgroup.com", match_type: "notEquals" },
    { field: "from_name", value: "DMARC Aggregate Report", match_type: "notEquals" },
    { field: "text_body", value: "The original mail was", match_type: "notContains" },
    { field: "text_body", value: "could not be delivered", match_type: "notContains" },
    // Filter node 2
    { field: "text_body", value: "DMARC", match_type: "notContains" },
    { field: "text_body", value: "Error message", match_type: "notContains" },
    { field: "text_body", value: "This is the mail system", match_type: "notContains" },
    { field: "text_body", value: "automated message", match_type: "notContains" },
    { field: "text_body", value: "I wasn't able to ", match_type: "notContains" },
    { field: "text_body", value: "Failed to deliver", match_type: "notContains" },
    { field: "text_body", value: "couldn't be delivered", match_type: "notContains" },
    { field: "text_body", value: "temporary problem", match_type: "notContains" },
    { field: "text_body", value: "not delivered", match_type: "notContains" },
    { field: "text_body", value: "empty response", match_type: "notContains" },
    // Filter node 3
    { field: "text_body", value: "please try again", match_type: "notContains" },
    { field: "text_body", value: "Error Type", match_type: "notContains" },
    { field: "text_body", value: "undeliverable", match_type: "notContains" },
    { field: "text_body", value: "address not found", match_type: "notContains" },
    { field: "text_body", value: "to postmaster", match_type: "notContains" },
    { field: "text_body", value: "message blocked", match_type: "notContains" },
    { field: "text_body", value: "Address not reachable", match_type: "notContains" },
    { field: "text_body", value: "Undeliverable", match_type: "notContains" },
    { field: "text_body", value: "Delivery has failed", match_type: "notContains" },
    { field: "from_name", value: "Mail Delivery", match_type: "notContains" },
    // Filter node 4
    { field: "from_email", value: "postmaster", match_type: "notContains" },
    { field: "from_email", value: "inbox", match_type: "notContains" },
    { field: "from_email", value: "dmarc", match_type: "notContains" },
    { field: "from_email", value: "daemon", match_type: "notContains" },
    { field: "text_body", value: "Delivery Status Notification", match_type: "notContains" },
    { field: "to_address", value: "inbox", match_type: "notContains" },
    { field: "from_email", value: "lincolnwastesolutionsgroup.com", match_type: "notContains" },
  ];

  for (const bf of bounceFilters) {
    await db.execute({
      sql: "INSERT INTO bounce_filters (field, value, match_type) VALUES (?, ?, ?)",
      args: [bf.field, bf.value, bf.match_type],
    });
  }
  console.log(`  ${bounceFilters.length} bounce filters`);

  console.log("\nSeed complete!");
}

seed().catch(console.error);
