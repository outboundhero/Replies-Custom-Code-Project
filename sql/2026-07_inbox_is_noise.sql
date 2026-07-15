-- ============================================================================
-- Inbox performance migration.
--
-- IMPORTANT — the Supabase SQL editor has a ~2-minute GATEWAY timeout per
-- request ("SQL query ran into an upstream timeout"). Do NOT paste this whole
-- file and run it at once. Either:
--   (A) run each numbered statement BELOW one at a time in the editor, or
--   (B) for the heavy steps (2 backfill, 3 indexes) use a DIRECT connection
--       (Supabase → Connect → connection string → psql / TablePlus / DBeaver),
--       which has no gateway timeout. Over a direct connection you can run the
--       one-shot backfill in step 2B.
--
-- The noise substrings mirror lib/inbox-noise.ts — keep the two in sync.
-- After this, run sql/inbox_category_counts.sql (the new RPC).
-- ============================================================================

-- 1) Add the flag column (instant) ------------------------------------------
ALTER TABLE replies ADD COLUMN IF NOT EXISTS inbox_is_noise boolean NOT NULL DEFAULT false;


-- 2A) Backfill — EDITOR path. Run this statement REPEATEDLY until it reports
--     "UPDATE 0". Each run flips up to 20k noise rows (a few seconds). If a run
--     times out, lower LIMIT to 5000.
WITH batch AS (
  SELECT id FROM replies
  WHERE inbox_is_noise = false
    AND (
         reply_we_got ILIKE ANY (ARRAY[
           '%could not be delivered%','%DMARC%','%Error message%','%This is the mail system%',
           '%automated message%','%I wasn''t able to%','%Failed to deliver%','%Permanent fatal%',
           '%Permanent error%','%couldn''t be delivered%','%delivery has failed%','%temporary problem%',
           '%not delivered%','%empty response%','%please try again%','%Error Type%','%undeliverable%',
           '%address not found%','%to postmaster%','%message blocked%','%Address not reachable%',
           '%Delivery Status Notification%','%sah28aj19%'
         ])
      OR lead_email ILIKE ANY (ARRAY[
           '%inbox%','%dmarc%','%daemon%','%postmaster%','%alignable.com%','%hyperscale1.site%','%voltic%'
         ])
      OR to_email ILIKE ANY (ARRAY['%inbox%'])
      OR email_subject ILIKE ANY (ARRAY['%OutboundHero Cold%'])
    )
  LIMIT 20000
)
UPDATE replies r SET inbox_is_noise = true
FROM batch WHERE r.id = batch.id;
-- ^ repeat until "UPDATE 0".

-- 2B) Backfill — DIRECT-CONNECTION path (do the whole thing in one shot, no
--     gateway limit). Run these two lines together over a direct connection
--     INSTEAD of 2A:
-- SET statement_timeout = 0;
-- UPDATE replies SET inbox_is_noise = true
--   WHERE reply_we_got ILIKE ANY (ARRAY[/* …same reply terms as 2A… */])
--      OR lead_email    ILIKE ANY (ARRAY['%inbox%','%dmarc%','%daemon%','%postmaster%','%alignable.com%','%hyperscale1.site%','%voltic%'])
--      OR to_email      ILIKE ANY (ARRAY['%inbox%'])
--      OR email_subject ILIKE ANY (ARRAY['%OutboundHero Cold%']);


-- 3) Indexes — run each CREATE INDEX SEPARATELY (one query at a time). Each is
--    a few seconds on 245k rows. Run these AFTER the backfill (step 2) so the
--    partial indexes are built against the final flag values.
CREATE INDEX IF NOT EXISTS idx_replies_cherry_leads
  ON replies (client_tag, ai_categorized_lead_category, created_at DESC)
  WHERE inbox_is_noise = false;

CREATE INDEX IF NOT EXISTS idx_replies_cherry_counts
  ON replies (client_tag, ai_categorized_lead_category)
  WHERE inbox_is_noise = false;

CREATE INDEX IF NOT EXISTS idx_replies_master_leads
  ON replies (client_tag, lead_category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_replies_master_counts
  ON replies (client_tag, lead_category);

CREATE INDEX IF NOT EXISTS idx_replies_cherry_counts_global
  ON replies (ai_categorized_lead_category) WHERE inbox_is_noise = false;

-- Leads list ordered by recency for the ALL-CLIENTS view (no client_tag filter):
-- lets a bucket's leads seek by lead_category and scan in created_at order with
-- NO sort (the client_tag-leading indexes above can't help without a client
-- filter). This is the "loading under each category" fix.
CREATE INDEX IF NOT EXISTS idx_replies_leadcat_created
  ON replies (lead_category, created_at DESC);

-- 4) Refresh planner stats (fast) -------------------------------------------
ANALYZE replies;

-- 5) Finally, run sql/inbox_category_counts.sql (new RPC signature).
