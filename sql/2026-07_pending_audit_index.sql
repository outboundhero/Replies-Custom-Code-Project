-- Keep the audit-pending cron cheap on Disk IO: a partial index over ONLY the
-- un-audited, Airtable-linked leads (newest first). It stays tiny because it
-- shrinks as leads get audited, so the cron's lookup is index-served instead of
-- scanning the whole replies table every run. Run in the Supabase SQL editor.
CREATE INDEX IF NOT EXISTS idx_replies_pending_audit
  ON replies (reply_time DESC)
  WHERE industry_audit IS NULL AND airtable_record_id IS NOT NULL;
