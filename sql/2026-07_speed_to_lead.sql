-- ============================================================================
-- Speed-to-Lead timing columns on `replies`.
--
-- Records when a reply entered Open Response, when it was categorized out of it,
-- how long that took, and who did it — powering the live inbox timer and the
-- daily/weekly speed-to-lead reports. All ALTERs are instant metadata changes
-- (no table rewrite), so this is safe to run in the Supabase SQL editor.
--
-- The app writes these best-effort (a separate UPDATE), so it keeps working
-- before this runs; run it to light up the timer + reporting.
-- ============================================================================

-- When the reply entered Open Response. NULL for old rows → the app falls back
-- to created_at. Reset to now() whenever a reply is restored to Open Response.
ALTER TABLE replies ADD COLUMN IF NOT EXISTS open_response_at timestamptz;

-- When the reply was categorized OUT of Open Response (its "left OR" time).
-- Also updated on any later re-categorization (drives the 15-day archive clock).
-- Cleared when restored to Open Response.
ALTER TABLE replies ADD COLUMN IF NOT EXISTS categorized_at timestamptz;

-- Final seconds spent in Open Response, stamped once when it first leaves.
ALTER TABLE replies ADD COLUMN IF NOT EXISTS time_to_categorize_seconds integer;

-- Session email of the user who categorized it.
ALTER TABLE replies ADD COLUMN IF NOT EXISTS categorized_by text;

-- Reporting reads: positive categories categorized within a day/week window.
CREATE INDEX IF NOT EXISTS idx_replies_categorized_at
  ON replies (categorized_at DESC)
  WHERE categorized_at IS NOT NULL;

ANALYZE replies;
