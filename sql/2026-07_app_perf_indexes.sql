-- App-wide performance indexes (Turso).
--
-- These were applied directly via the libsql client (Turso writes are enabled),
-- so no manual run is needed — this file is the record / re-apply reference.
--
--   idx_error_log_workflow_id          → Error Log filtered-by-workflow views
--                                        (was an unindexed scan to fill LIMIT).
--   idx_nurture_source_routed_uppertag → nurture "source-campaigns" GROUP BY,
--                                        an EXPRESSION index matching the query's
--                                        `WHERE UPPER(client_tag)=?` verbatim so
--                                        it no longer full-scans ~1M rows.

CREATE INDEX IF NOT EXISTS idx_error_log_workflow_id
  ON error_log(workflow, id DESC);

CREATE INDEX IF NOT EXISTS idx_nurture_source_routed_uppertag
  ON nurture_source_routed(UPPER(client_tag), source_campaign_id);
