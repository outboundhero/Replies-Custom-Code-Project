import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export default db;

// ── Schema initialization ──

export async function initializeDatabase() {
  // Use individual execute() calls instead of executeMultiple() which hangs
  // in the Next.js production runtime with Turso
  const statements = [
    `CREATE TABLE IF NOT EXISTS sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      airtable_base_id TEXT NOT NULL,
      airtable_table_id TEXT NOT NULL DEFAULT 'tbl1BnpnsUBrBGeuy',
      meeting_ready_table_id TEXT DEFAULT 'tblmBx4BWbmeJMNN1',
      clay_webhook_url_tracked TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS client_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag TEXT NOT NULL UNIQUE,
      section_id INTEGER NOT NULL,
      FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS untracked_config (
      id INTEGER PRIMARY KEY,
      airtable_base_id TEXT NOT NULL,
      airtable_table_id TEXT NOT NULL DEFAULT 'tbl1BnpnsUBrBGeuy',
      meeting_ready_table_id TEXT DEFAULT 'tblmBx4BWbmeJMNN1',
      clay_webhook_url TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS company_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      pattern TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS bounce_filters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field TEXT NOT NULL,
      value TEXT NOT NULL,
      match_type TEXT NOT NULL DEFAULT 'notContains'
    )`,
    `CREATE TABLE IF NOT EXISTS error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      workflow TEXT NOT NULL,
      stage TEXT NOT NULL,
      message TEXT NOT NULL,
      payload TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      workflow TEXT NOT NULL,
      client_tag TEXT,
      section_name TEXT,
      lead_email TEXT,
      action TEXT NOT NULL,
      details TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS client_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_tag TEXT NOT NULL UNIQUE,
      cc_name_1 TEXT, cc_email_1 TEXT,
      cc_name_2 TEXT, cc_email_2 TEXT,
      cc_name_3 TEXT, cc_email_3 TEXT,
      cc_name_4 TEXT, cc_email_4 TEXT,
      cc_name_5 TEXT, cc_email_5 TEXT,
      cc_name_6 TEXT, cc_email_6 TEXT,
      bcc_name_1 TEXT, bcc_email_1 TEXT,
      bcc_name_2 TEXT, bcc_email_2 TEXT,
      reply_template TEXT,
      auto_nurture_enabled INTEGER NOT NULL DEFAULT 0,
      auto_nurture_enabled_at TEXT,
      auto_nurture_last_run_at TEXT,
      auto_nurture_disabled INTEGER NOT NULL DEFAULT 0,
      auto_nurture_disabled_at TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS client_instances (
      client_tag TEXT PRIMARY KEY,
      instance_key TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT
    )`,
    // Nurture group (1 or 2) per client → drives which B2B/B2C Bison instances
    // its leads route to. Synced from the instance-mapping sheet by
    // /api/cron/sync-client-groups. See lib/nurture/group-routing.ts.
    `CREATE TABLE IF NOT EXISTS client_groups (
      client_tag TEXT PRIMARY KEY,
      group_num INTEGER NOT NULL,
      synced_at TEXT
    )`,
    // Churned clients (Status=Churned + Churn Date), synced from the Client
    // Tracker sheet by /api/cron/sync-churned-clients. See lib/churn.ts.
    `CREATE TABLE IF NOT EXISTS churned_clients (
      client_tag TEXT PRIMARY KEY,
      synced_at TEXT
    )`,
    // Where a lead physically lives after cross-instance placement: its
    // instance-specific Bison lead id, keyed by (instance, email). Lets the
    // route engine attach a placed lead to its campaign WITHOUT re-creating /
    // re-looking-it-up. Populated by scripts/place-leads.ts and the engine.
    `CREATE TABLE IF NOT EXISTS nurture_instance_lead (
      bison_instance TEXT NOT NULL,
      email TEXT NOT NULL,
      lead_id INTEGER NOT NULL,
      client_tag TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (bison_instance, email)
    )`,
    // Audit + batch counter for auto-expanded nurture campaigns. One row per
    // expansion of a (client, instance, ESP) routing → the next batch number,
    // the old campaign, and the new (cloned) campaign. Drives the "Batch N"
    // naming + the Recent-expansions feed.
    `CREATE TABLE IF NOT EXISTS nurture_campaign_expansions (
      client_tag TEXT NOT NULL,
      bison_instance TEXT NOT NULL,
      esp TEXT NOT NULL,
      batch INTEGER NOT NULL,
      old_campaign_id INTEGER,
      new_campaign_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (client_tag, bison_instance, esp, batch)
    )`,
    // Latest health snapshot per mapped nurture campaign, written by the
    // expansion evaluator each run (completion %, total leads, status). The
    // Campaigns monitoring tab reads this so the page is Turso-only and fast.
    `CREATE TABLE IF NOT EXISTS nurture_routing_health (
      client_tag TEXT NOT NULL,
      bison_instance TEXT NOT NULL,
      esp TEXT NOT NULL,
      campaign_id INTEGER,
      campaign_name TEXT,
      completion_percentage REAL,
      total_leads INTEGER,
      status TEXT,
      batch INTEGER,
      checked_at TEXT,
      PRIMARY KEY (client_tag, bison_instance, esp)
    )`,
    // Operator-confirmed target campaign per (client, instance, ESP). The
    // nurture route engine (manual Route-all + auto-push) sends leads ONLY to
    // the campaigns chosen here — nothing is auto-picked. A client can't be
    // sent to until its map is confirmed (client_config.nurture_map_confirmed_at).
    `CREATE TABLE IF NOT EXISTS nurture_campaign_map (
      client_tag TEXT NOT NULL,
      bison_instance TEXT NOT NULL,
      esp TEXT NOT NULL,
      campaign_id INTEGER NOT NULL,
      campaign_name TEXT,
      lane TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (client_tag, bison_instance, esp)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_client_tags_tag ON client_tags(tag)`,
    `CREATE INDEX IF NOT EXISTS idx_client_config_tag ON client_config(client_tag)`,
    `CREATE INDEX IF NOT EXISTS idx_company_codes_priority ON company_codes(priority DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_error_log_timestamp ON error_log(timestamp DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON activity_log(timestamp DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_client_instances_key ON client_instances(instance_key)`,
  ];

  for (const sql of statements) {
    await db.execute(sql);
  }

  // Add CC 5/6 columns if missing
  for (const col of ["cc_name_5", "cc_email_5", "cc_name_6", "cc_email_6"]) {
    try {
      await db.execute(`ALTER TABLE client_config ADD COLUMN ${col} TEXT`);
    } catch {
      // Column already exists — ignore
    }
  }

  // Timestamp set when an operator confirms the client's target-campaign map.
  // Gates all nurture sending (Route-all / Auto-route / auto-push cron).
  for (const col of ["nurture_map_confirmed_at TEXT"]) {
    try {
      await db.execute(`ALTER TABLE client_config ADD COLUMN ${col}`);
    } catch {
      // Column already exists — ignore
    }
  }
}
