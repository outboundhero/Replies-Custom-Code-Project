-- Nurture redesign — patch 2 (2026-10-09): lighter per-tag stats.
-- Run this whole file once in the Supabase SQL editor (safe to re-run).
--   • nurture_tag_stats no longer computes the cross-tag overlap count (~90% of
--     its cost) and returns the queue tab's first page from the same pass.
--   • nurture_tag_overlap computes the overlap count separately (overnight).

-- Per-tag numbers for the client page + overview (one JSON object), plus the
-- queue tab's first page (50 contacts, same order as nurture_queue_page) from
-- the SAME pass. The cross-tag "overlap" count is NOT here — it was ~90% of
-- this query's cost (every email checked against every other queue) and runs
-- separately, overnight (nurture_tag_overlap). Disk-heavy queries on the shared
-- database slow the inbox, so this one stays as light as possible.
CREATE OR REPLACE FUNCTION nurture_tag_stats(p_tag text, p_ignore_tags text[] DEFAULT '{}')
RETURNS jsonb LANGUAGE sql STABLE
SET statement_timeout = '120s'
AS $$
  WITH c AS (SELECT * FROM nurture_queue_contacts(p_tag)),
  days AS (SELECT generate_series(0, 29) AS d),
  fc AS (
    SELECT d.d, count(c.email)::int AS n
    FROM days d
    LEFT JOIN c ON NOT c.is_eligible
               AND floor(extract(epoch FROM (c.eligible_at - now())) / 86400)::int = d.d
    GROUP BY d.d
  ),
  pg AS (
    SELECT c.* FROM c
    ORDER BY CASE WHEN c.is_ready THEN 0 WHEN NOT c.is_eligible THEN 1 ELSE 2 END, c.trigger_at ASC, c.email ASC
    LIMIT 50
  ),
  pov AS (SELECT * FROM nurture_email_other_tags(p_tag, ARRAY(SELECT pg.email FROM pg), p_ignore_tags))
  SELECT jsonb_build_object(
    'queue',         (SELECT count(*) FROM c),
    'eligible',      (SELECT count(*) FILTER (WHERE c.is_eligible) FROM c),
    'ready',         (SELECT count(*) FILTER (WHERE c.is_ready) FROM c),
    'cooldown',      (SELECT count(*) FILTER (WHERE NOT c.is_eligible) FROM c),
    'esp_unresolved',(SELECT count(*) FILTER (WHERE NOT c.esp_resolved) FROM c),
    'sources',       coalesce((SELECT jsonb_object_agg(x.source, x.n) FROM (SELECT c.source, count(*) AS n FROM c GROUP BY c.source) x), '{}'::jsonb),
    'esps',          coalesce((SELECT jsonb_object_agg(x.esp, x.n) FROM (SELECT c.esp, count(*) AS n FROM c GROUP BY c.esp) x), '{}'::jsonb),
    'tlds',          coalesce((SELECT jsonb_object_agg(x.tld, x.n) FROM (SELECT coalesce(c.tld, '?') AS tld, count(*) AS n FROM c GROUP BY 1) x), '{}'::jsonb),
    'email_endings', coalesce((SELECT jsonb_object_agg(x.e, x.n) FROM (SELECT e.e, count(*) AS n FROM c, unnest(nurture_domain_endings(split_part(c.email, '@', 2))) AS e(e) GROUP BY e.e) x), '{}'::jsonb),
    'site_endings',  coalesce((SELECT jsonb_object_agg(x.e, x.n) FROM (SELECT e.e, count(*) AS n FROM c, unnest(nurture_domain_endings(c.website)) AS e(e) GROUP BY e.e) x), '{}'::jsonb),
    'email_domains', coalesce((SELECT jsonb_object_agg(x.d, x.n) FROM (SELECT split_part(c.email, '@', 2) AS d, count(*) AS n FROM c WHERE split_part(c.email, '@', 2) = ANY (nurture_personal_domains()) GROUP BY 1) x), '{}'::jsonb),
    'forecast',      (SELECT jsonb_agg(fc.n ORDER BY fc.d) FROM fc),
    'last_new_at',   (SELECT max(c.trigger_at) FROM c),
    'page1',         coalesce((SELECT jsonb_agg(jsonb_build_object(
                         'email', pg.email, 'first_name', pg.first_name, 'last_name', pg.last_name, 'company', pg.company,
                         'website', pg.website, 'tld', pg.tld, 'source', pg.source, 'esp', pg.esp, 'esp_resolved', pg.esp_resolved,
                         'trigger_at', pg.trigger_at, 'eligible_at', pg.eligible_at, 'is_eligible', pg.is_eligible,
                         'is_ready', pg.is_ready, 'row_count', pg.row_count, 'overlap_tags', coalesce(pov.tags, '{}'::text[]))
                       ORDER BY CASE WHEN pg.is_ready THEN 0 WHEN NOT pg.is_eligible THEN 1 ELSE 2 END, pg.trigger_at, pg.email)
                       FROM pg LEFT JOIN pov ON pov.email = pg.email), '[]'::jsonb),
    'computed_at',   now()
  )
$$;

-- How many of a tag's queued contacts are ALSO waiting in another (non-ignored)
-- tag's queue — the "Overlapping" panel. Heavy (every email checked against
-- every queue), so it runs overnight, one tag at a time.
CREATE OR REPLACE FUNCTION nurture_tag_overlap(p_tag text, p_ignore_tags text[] DEFAULT '{}')
RETURNS integer LANGUAGE sql STABLE
SET statement_timeout = '120s'
AS $$
  SELECT count(*)::int
  FROM nurture_email_other_tags(p_tag, ARRAY(SELECT DISTINCT b.email FROM nurture_queue_base(p_tag) b), p_ignore_tags)
$$;

REVOKE ALL ON FUNCTION nurture_tag_overlap(text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION nurture_tag_overlap(text, text[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION nurture_tag_overlap(text, text[]) TO service_role;
