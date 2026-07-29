-- Keep the audit-pending cron cheap on Disk IO. A partial index over ONLY the
-- un-audited, Airtable-linked leads in the POSITIVE AI categories the cron
-- looks at — i.e. the actual audit backlog, which is small and shrinks as leads
-- get audited. This matches the cron's query exactly, so the lookup is
-- index-served (a few rows) instead of scanning the ~280k-row replies table.
-- Small + fast to build even on a constrained instance. Run in the SQL editor.
CREATE INDEX IF NOT EXISTS idx_replies_pending_audit
  ON replies (reply_time DESC)
  WHERE industry_audit IS NULL
    AND airtable_record_id IS NOT NULL
    AND ai_categorized_lead_category IN ('Interested', 'Meeting Request', 'Referral Given', 'Internally Forwarded');
