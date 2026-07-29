-- BIG Disk IO win. The qualification audit (and the CW router) update replies
-- with `WHERE airtable_record_id = ...`, but there was NO index on that column,
-- so every audit update FULL-SCANNED the ~280k-row table to find one row
-- (~41k disk blocks read per update, tens of millions total). This b-tree index
-- turns each into a single-row lookup. Run in the Supabase SQL editor.
CREATE INDEX IF NOT EXISTS idx_replies_airtable_record_id
  ON replies (airtable_record_id)
  WHERE airtable_record_id IS NOT NULL;
