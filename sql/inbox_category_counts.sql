-- Single-query inbox category counts (dynamic, index-friendly).
--
-- v2: builds the WHERE clause dynamically so each call only contains the
-- predicates that actually apply. The earlier `(p_x IS NULL OR col = p_x)`
-- form was non-sargable and forced a sequential scan (~1.9s); inlining only the
-- active, constant predicates lets the planner use the partial indexes from
-- sql/2026-07_inbox_is_noise.sql (client-scoped ~250ms, all-clients ~1s).
--
-- Noise is precomputed at ingest into the indexed boolean `inbox_is_noise`; the
-- view's AI-category allowlist is passed as exact-match text[]. No leading-
-- wildcard ILIKEs (except the optional free-text search). Grouping stays on
-- `lead_category` so sidebar labels are preserved; the route drops the view's
-- hiddenLeadCategories afterward. All params nullable — pass NULL to skip.
--
-- Literals are inlined via format('%L', ...) which quotes/escapes safely.

CREATE OR REPLACE FUNCTION inbox_category_counts(
  p_client_tag    text    DEFAULT NULL,
  p_allowed_tags  text[]  DEFAULT NULL,
  p_workflow      text    DEFAULT NULL,
  p_search        text    DEFAULT NULL,
  p_exclude_noise boolean DEFAULT false,
  p_ai_allowlist  text[]  DEFAULT NULL
)
RETURNS TABLE (lead_category text, n bigint)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $$
DECLARE
  sql text := 'SELECT COALESCE(lead_category, ''(uncategorized)'') AS lead_category, COUNT(*)::bigint AS n FROM replies WHERE true';
BEGIN
  IF p_client_tag IS NOT NULL THEN
    sql := sql || format(' AND client_tag = %L', p_client_tag);
  ELSIF p_allowed_tags IS NOT NULL THEN
    sql := sql || format(' AND client_tag = ANY(%L::text[])', p_allowed_tags);
  END IF;

  IF p_workflow IS NOT NULL THEN
    sql := sql || format(' AND workflow = %L', p_workflow);
  END IF;

  IF p_exclude_noise THEN
    sql := sql || ' AND inbox_is_noise = false';
  END IF;

  IF p_ai_allowlist IS NOT NULL THEN
    sql := sql || format(' AND ai_categorized_lead_category = ANY(%L::text[])', p_ai_allowlist);
  END IF;

  IF p_search IS NOT NULL THEN
    sql := sql || format(
      ' AND (lead_email ILIKE %L OR company_name ILIKE %L OR lead_name ILIKE %L)',
      '%' || p_search || '%', '%' || p_search || '%', '%' || p_search || '%');
  END IF;

  sql := sql || ' GROUP BY COALESCE(lead_category, ''(uncategorized)'')';
  RETURN QUERY EXECUTE sql;
END;
$$;
