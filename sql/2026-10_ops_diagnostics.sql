-- Read-only database diagnostics the app (service role only) can sample while
-- the inbox is slow — what's running right now, and what uses the most time.
-- Run this whole block once in the Supabase SQL editor.
CREATE OR REPLACE FUNCTION ops_active_queries()
RETURNS TABLE (pid integer, running_ms bigint, state text, wait_event_type text, wait_event text, app text, query text)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT a.pid, (extract(epoch FROM (now() - a.query_start)) * 1000)::bigint, a.state,
         a.wait_event_type, a.wait_event, a.application_name,
         left(regexp_replace(a.query, '\s+', ' ', 'g'), 400)
  FROM pg_stat_activity a
  WHERE a.state <> 'idle' AND a.pid <> pg_backend_pid() AND a.backend_type = 'client backend'
  ORDER BY a.query_start
$$;

CREATE OR REPLACE FUNCTION ops_top_statements(p_limit integer DEFAULT 25)
RETURNS TABLE (total_sec numeric, calls bigint, avg_ms numeric, max_ms numeric, query text)
LANGUAGE sql SECURITY DEFINER
SET search_path = extensions, public, pg_catalog
AS $$
  SELECT round((s.total_exec_time / 1000)::numeric, 1), s.calls,
         round(s.mean_exec_time::numeric), round(s.max_exec_time::numeric),
         left(regexp_replace(s.query, '\s+', ' ', 'g'), 400)
  FROM pg_stat_statements s
  ORDER BY s.total_exec_time DESC
  LIMIT greatest(1, least(coalesce(p_limit, 25), 100))
$$;

REVOKE ALL ON FUNCTION ops_active_queries() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ops_top_statements(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ops_active_queries() TO service_role;
GRANT EXECUTE ON FUNCTION ops_top_statements(integer) TO service_role;
