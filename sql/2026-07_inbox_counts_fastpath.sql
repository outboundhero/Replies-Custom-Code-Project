-- ============================================================================
-- Inbox counts fast-path index (immediate relief).
--
-- The all-clients "Base Clients (Cherry)" counts aggregate over the whole
-- replies table (~1s at 270k rows). inbox_category_counts inlines its filters
-- as LITERALS (format('%L', …)), so a partial index whose predicate matches the
-- Cherry view exactly lets the planner do a small index-only grouped scan
-- instead of a full-table aggregate.
--
-- Run as a SINGLE statement over a DIRECT connection (CONCURRENTLY cannot run
-- inside the Supabase SQL editor's implicit transaction). Keep the allowlist in
-- sync with base-clients-cherry in lib/inbox-views.ts.
-- ============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_replies_cherry_leadcat
  ON replies (lead_category)
  WHERE inbox_is_noise = false
    AND ai_categorized_lead_category IN (
      'Interested',
      'Meeting Request',
      'Follow Up at a Later Date',
      'Referral Given',
      'Internally Forwarded',
      'Unrecognizable by AI'
    );

ANALYZE replies;
