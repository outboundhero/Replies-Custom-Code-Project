-- DM4PM interested-reply subsequence — badge/view columns on `replies`.
--
-- The subsequence state itself lives in Turso (dm4pm_subsequence). These two
-- columns are a best-effort MIRROR of that state onto the reply row so the inbox
-- can render the "In Subsequence · Step N" badge and filter the "DM4PM
-- Subsequence" view / counts server-side (Postgres views can only filter on real
-- reply columns).
--
-- Safe to run more than once. Until this runs, the app feature-detects the
-- columns and simply omits the badge/view (nothing breaks).

ALTER TABLE replies ADD COLUMN IF NOT EXISTS dm4pm_subseq_status TEXT;
ALTER TABLE replies ADD COLUMN IF NOT EXISTS dm4pm_subseq_step   INTEGER;

-- Partial index — only the (small) set of rows in a subsequence, for the
-- "DM4PM Subsequence" view's `WHERE dm4pm_subseq_status IS NOT NULL`.
CREATE INDEX IF NOT EXISTS idx_replies_dm4pm_subseq
  ON replies (dm4pm_subseq_status)
  WHERE dm4pm_subseq_status IS NOT NULL;
