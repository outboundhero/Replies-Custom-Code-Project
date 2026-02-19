import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export default db;

// ── Schema initialization ──

export async function initializeDatabase() {
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

    CREATE TABLE IF NOT EXISTS client_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_tag TEXT NOT NULL UNIQUE,
      cc_name_1 TEXT,
      cc_email_1 TEXT,
      cc_name_2 TEXT,
      cc_email_2 TEXT,
      cc_name_3 TEXT,
      cc_email_3 TEXT,
      cc_name_4 TEXT,
      cc_email_4 TEXT,
      bcc_name_1 TEXT,
      bcc_email_1 TEXT,
      bcc_name_2 TEXT,
      bcc_email_2 TEXT,
      reply_template TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_client_tags_tag ON client_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_client_config_tag ON client_config(client_tag);
    CREATE INDEX IF NOT EXISTS idx_company_codes_priority ON company_codes(priority DESC);
    CREATE INDEX IF NOT EXISTS idx_error_log_timestamp ON error_log(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON activity_log(timestamp DESC);
  `);
}
