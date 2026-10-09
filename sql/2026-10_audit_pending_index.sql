-- audit-pending cron: make its "any un-audited positive leads?" lookup index-served again.
--
-- The old idx_replies_pending_audit also required airtable_record_id IS NOT NULL;
-- since the Airtable cutover the cron no longer filters on that, so Postgres
-- couldn't use it and walked the whole replies table every 10 minutes
-- (~3.3s per run, up to the 8s timeout, competing with the inbox for disk) —
-- even when the backlog is empty. This index matches the cron's query exactly:
-- it holds only the un-audited positive leads (usually none), so the lookup is
-- ~instant. Keep it in sync with app/api/cron/audit-pending/route.ts.
--
-- Run in the Supabase SQL editor, ONE STATEMENT AT A TIME (CONCURRENTLY can't
-- run inside a transaction). Neither step locks the table against writes.

-- STEP 1 — build the new index (one pass over replies, then tiny).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_replies_pending_audit_v2
  ON replies (reply_time DESC)
  WHERE industry_audit IS NULL
    AND ai_categorized_lead_category IN ('Interested', 'Meeting Request', 'Referral Given', 'Internally Forwarded');

-- STEP 2 — drop the old one (nothing can use it any more; it only costs writes).
DROP INDEX CONCURRENTLY IF EXISTS idx_replies_pending_audit;

-- STEP 3 — check: expect exactly one row, idx_replies_pending_audit_v2, valid = true.
SELECT c.relname AS index, i.indisvalid AS valid
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname LIKE 'idx_replies_pending_audit%';
