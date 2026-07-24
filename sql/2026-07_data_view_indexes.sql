-- Data View performance indexes (spec §13 at production scale).
-- Run in the Supabase SQL editor. Plain CREATE INDEX (no CONCURRENTLY — the
-- editor runs statements in a transaction). Each is partial on the ACTIVE set
-- (archived = false) so they stay small and stay fast as history grows.

-- 1) Column sorts (click-a-header). created_at DESC is already index-served;
--    these cover the rest. categorized_at needs DESC NULLS LAST explicitly so
--    "recently categorized" doesn't surface the never-categorized nulls first.
CREATE INDEX IF NOT EXISTS idx_replies_active_categorized_desc
  ON replies (categorized_at DESC NULLS LAST) WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_replies_active_lead_name
  ON replies (lead_name) WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_replies_active_company
  ON replies (company_name) WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_replies_active_lead_category_sort
  ON replies (lead_category) WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_replies_active_ai_category_sort
  ON replies (ai_categorized_lead_category) WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_replies_active_client_tag_sort
  ON replies (client_tag) WHERE archived = false;

-- 2) Fast substring search (name / email / company / reply content).
--    Trigram GIN indexes make ILIKE '%term%' index-served instead of a scan,
--    so a rare search term can't blow the statement timeout.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_replies_active_trgm_lead_email
  ON replies USING gin (lead_email gin_trgm_ops) WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_replies_active_trgm_lead_name
  ON replies USING gin (lead_name gin_trgm_ops) WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_replies_active_trgm_company
  ON replies USING gin (company_name gin_trgm_ops) WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_replies_active_trgm_from_email
  ON replies USING gin (from_email gin_trgm_ops) WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_replies_active_trgm_reply
  ON replies USING gin (reply_we_got gin_trgm_ops) WHERE archived = false;
