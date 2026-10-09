-- Indexes for the sequence-finished sync's "already known?" checks
-- (lib/nurture/sync-sequence-finished.ts): it looks contacts up by
-- (client_tag, lead_email) in replies and nurture_legacy_leads on every run —
-- ~275k calls each in pg_stat_statements, avg ~200ms, max 8s.
-- Run EACH statement ON ITS OWN (CONCURRENTLY can't run inside a transaction;
-- builds without locking writes).
CREATE INDEX CONCURRENTLY IF NOT EXISTS replies_tag_lead_email_idx
  ON replies (client_tag, lead_email);

CREATE INDEX CONCURRENTLY IF NOT EXISTS nurture_legacy_tag_email_idx
  ON nurture_legacy_leads (client_tag, lead_email);
