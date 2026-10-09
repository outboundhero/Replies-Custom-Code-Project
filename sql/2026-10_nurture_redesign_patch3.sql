-- ════════════════════════════════════════════════════════════════════════════
-- Nurture redesign — PATCH 3 (SQL audit, 2026-10-09). Run this whole file once
-- in the Supabase SQL editor (one go; re-runnable). Same function signatures,
-- so nothing that calls them changes. No table writes, no index builds.
--
--   1. nurture_excluded_categories — + 'Meeting-Ready Lead' / 'Meeting Ready
--      Lead' (auto-push never routes them, so they sat in the queue as "Ready").
--   2. nurture_queue_contacts — a ready contact shows the ESP of the row
--      auto-push would actually send (was: its oldest row's).
--   3. nurture_email_other_tags — work_mem 64MB: on big tags the overlap lookup
--      went lossy and ran for minutes (measured: >90s → ~3s at 20k contacts).
--   4. nurture_queue_page + nurture_tag_stats — cooling contacts sorted
--      soonest-eligible first (was: by their oldest row).
--   5. nurture_queue_restore — retired (unused; Undo is exact, by row id).
--   6. nurture_clients_summary — same excluded categories (classic hub counts).
--   7. ops_* diagnostics — pg_catalog first on their search_path.
-- ════════════════════════════════════════════════════════════════════════════

-- 1
CREATE OR REPLACE FUNCTION nurture_excluded_categories()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'Interested','Meeting Request','Meeting Set','Do Not Contact',
    'Wrong Person','Wrong Person (Change of Target)','Not Interested',
    'Mailbox No Longer Active','Automated Error Message',
    'Automated Catch-All Message','Referral Given','Internally Forwarded',
    'Meeting-Ready Lead','Meeting Ready Lead'
  ]::text[]
$$;

-- 2
CREATE OR REPLACE FUNCTION nurture_queue_contacts(p_tag text)
RETURNS TABLE (
  email text, src text, row_id bigint, first_name text, last_name text, company text,
  website text, source text, esp text, esp_resolved boolean,
  trigger_at timestamptz, eligible_at timestamptz, is_eligible boolean, is_ready boolean,
  tld text, row_count integer
)
LANGUAGE sql STABLE AS $$
  WITH b AS (SELECT * FROM nurture_queue_base(p_tag)),
  agg AS (
    SELECT b.email,
           bool_or(b.safe AND b.trigger_at <= now() - interval '45 days'
                   AND coalesce(btrim(b.esp_host), '') <> '') AS ready_any,
           min(b.trigger_at) FILTER (WHERE b.safe AND b.trigger_at > now() - interval '45 days') AS next_safe_trigger,
           (array_agg(b.esp_host ORDER BY b.trigger_at, b.src, b.row_id)
              FILTER (WHERE b.safe AND b.trigger_at <= now() - interval '45 days'
                      AND coalesce(btrim(b.esp_host), '') <> ''))[1] AS ready_esp,
           count(*)::int AS n
    FROM b GROUP BY b.email
  ),
  first_row AS (
    SELECT DISTINCT ON (b.email) b.*
    FROM b ORDER BY b.email, b.trigger_at ASC, b.src, b.row_id
  )
  SELECT f.email, f.src, f.row_id, f.first_name, f.last_name, f.company,
         nurture_contact_site(f.website, f.email),
         f.source,
         nurture_esp_bucket(coalesce(a.ready_esp, f.esp_host), f.email),
         coalesce(btrim(coalesce(a.ready_esp, f.esp_host)), '') <> '',
         f.trigger_at,
         CASE WHEN NOT a.ready_any AND a.next_safe_trigger IS NOT NULL THEN a.next_safe_trigger ELSE f.trigger_at END
           + interval '45 days',
         CASE WHEN a.ready_any THEN true
              WHEN a.next_safe_trigger IS NOT NULL THEN false
              ELSE f.trigger_at <= now() - interval '45 days' END,
         a.ready_any,
         substring(split_part(f.email, '@', 2) from '(\.[a-z0-9-]+)$'),
         a.n
  FROM first_row f JOIN agg a ON a.email = f.email
$$;

-- 3
ALTER FUNCTION nurture_email_other_tags(text, text[], text[]) SET work_mem = '64MB';

-- 4
CREATE OR REPLACE FUNCTION nurture_queue_page(
  p_tag text, p_search text DEFAULT NULL, p_email_suffix text DEFAULT NULL,
  p_web_suffix text DEFAULT NULL, p_source text DEFAULT NULL, p_tld text DEFAULT NULL,
  p_overlap_only boolean DEFAULT false, p_ignore_tags text[] DEFAULT '{}',
  p_limit integer DEFAULT 50, p_offset integer DEFAULT 0
)
RETURNS TABLE (
  email text, src text, row_id bigint, first_name text, last_name text, company text,
  website text, source text, esp text, esp_resolved boolean,
  trigger_at timestamptz, eligible_at timestamptz, is_eligible boolean, is_ready boolean,
  tld text, row_count integer, overlap_tags text[], total_count bigint
)
LANGUAGE sql STABLE
SET statement_timeout = '60s'
AS $$
  WITH f AS (
    SELECT * FROM nurture_queue_filtered(p_tag, p_search, p_email_suffix, p_web_suffix, p_source, p_tld, p_overlap_only, p_ignore_tags)
  ),
  page AS (
    SELECT f.*, count(*) OVER () AS total_count
    FROM f
    ORDER BY CASE WHEN f.is_ready THEN 0 WHEN NOT f.is_eligible THEN 1 ELSE 2 END, f.eligible_at ASC, f.email ASC
    LIMIT greatest(1, least(coalesce(p_limit, 50), 500)) OFFSET greatest(0, coalesce(p_offset, 0))
  ),
  ov AS (
    SELECT * FROM nurture_email_other_tags(p_tag, ARRAY(SELECT p.email FROM page p), p_ignore_tags)
  )
  SELECT p.email, p.src, p.row_id, p.first_name, p.last_name, p.company, p.website, p.source, p.esp,
         p.esp_resolved, p.trigger_at, p.eligible_at, p.is_eligible, p.is_ready, p.tld, p.row_count,
         coalesce(ov.tags, '{}'::text[]), p.total_count
  FROM page p LEFT JOIN ov ON ov.email = p.email
  ORDER BY CASE WHEN p.is_ready THEN 0 WHEN NOT p.is_eligible THEN 1 ELSE 2 END, p.eligible_at ASC, p.email ASC
$$;

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
    ORDER BY CASE WHEN c.is_ready THEN 0 WHEN NOT c.is_eligible THEN 1 ELSE 2 END, c.eligible_at ASC, c.email ASC
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
                       ORDER BY CASE WHEN pg.is_ready THEN 0 WHEN NOT pg.is_eligible THEN 1 ELSE 2 END, pg.eligible_at, pg.email)
                       FROM pg LEFT JOIN pov ON pov.email = pg.email), '[]'::jsonb),
    'computed_at',   now()
  )
$$;

-- 5
DROP FUNCTION IF EXISTS nurture_queue_restore(text, text[]);

-- 6
CREATE OR REPLACE FUNCTION nurture_clients_summary(cutoff timestamptz)
RETURNS TABLE (
  client_tag text, ready bigint, eligible bigint, waiting bigint, added bigint
)
LANGUAGE sql STABLE
AS $$
  WITH excluded AS (
    SELECT unnest(ARRAY[
      'Interested','Meeting Request','Meeting Set','Do Not Contact',
      'Wrong Person','Wrong Person (Change of Target)','Not Interested',
      'Mailbox No Longer Active','Automated Error Message',
      'Automated Catch-All Message','Referral Given','Internally Forwarded',
      'Meeting-Ready Lead','Meeting Ready Lead'
    ]) AS cat
  ),
  unioned AS (
    SELECT
      client_tag,
      CASE WHEN reply_time <= cutoff AND nurture_added_at IS NULL
                AND COALESCE(nurture_skipped, false) = false
                AND nurture_safety = 'safe' THEN 1 ELSE 0 END AS ready,
      CASE WHEN reply_time <= cutoff AND nurture_added_at IS NULL
                AND COALESCE(nurture_skipped, false) = false THEN 1 ELSE 0 END AS eligible,
      CASE WHEN reply_time >  cutoff AND nurture_added_at IS NULL
                AND COALESCE(nurture_skipped, false) = false THEN 1 ELSE 0 END AS waiting,
      CASE WHEN nurture_added_at IS NOT NULL THEN 1 ELSE 0 END AS added,
      lower(lead_email) AS email
    FROM replies
    WHERE reply_we_got IS NOT NULL AND reply_we_got <> ''
      AND reply_time IS NOT NULL
      AND client_tag IS NOT NULL AND client_tag <> 'N/A'
      AND (ai_categorized_lead_category IS NULL
           OR ai_categorized_lead_category NOT IN (SELECT cat FROM excluded))

    UNION ALL

    SELECT
      client_tag,
      CASE WHEN sequence_finished_at <= cutoff AND added_at IS NULL
                AND COALESCE(skipped, false) = false THEN 1 ELSE 0 END,
      CASE WHEN sequence_finished_at <= cutoff AND added_at IS NULL
                AND COALESCE(skipped, false) = false THEN 1 ELSE 0 END,
      CASE WHEN sequence_finished_at >  cutoff AND added_at IS NULL
                AND COALESCE(skipped, false) = false THEN 1 ELSE 0 END,
      CASE WHEN added_at IS NOT NULL THEN 1 ELSE 0 END,
      lower(email)
    FROM nurture_sequence_finished
    WHERE client_tag IS NOT NULL AND client_tag <> 'N/A'

    UNION ALL

    SELECT
      client_tag,
      CASE WHEN reply_at <= cutoff AND nurture_added_at IS NULL
                AND COALESCE(nurture_skipped, false) = false
                AND nurture_safety = 'safe' THEN 1 ELSE 0 END,
      CASE WHEN reply_at <= cutoff AND nurture_added_at IS NULL
                AND COALESCE(nurture_skipped, false) = false THEN 1 ELSE 0 END,
      CASE WHEN reply_at >  cutoff AND nurture_added_at IS NULL
                AND COALESCE(nurture_skipped, false) = false THEN 1 ELSE 0 END,
      CASE WHEN nurture_added_at IS NOT NULL THEN 1 ELSE 0 END,
      lower(lead_email)
    FROM nurture_legacy_leads
    WHERE client_tag IS NOT NULL AND client_tag <> 'N/A'
      AND (original_ai_category IS NULL
           OR original_ai_category NOT IN (SELECT cat FROM excluded))
  )
  SELECT
    client_tag,
    SUM(ready)::bigint    AS ready,
    SUM(eligible)::bigint AS eligible,
    SUM(waiting)::bigint  AS waiting,
    (COUNT(DISTINCT email) FILTER (WHERE added = 1 AND email IS NOT NULL AND email <> ''))::bigint AS added
  FROM unioned
  GROUP BY client_tag
  ORDER BY client_tag;
$$;

-- 7
ALTER FUNCTION ops_active_queries() SET search_path = pg_catalog;
ALTER FUNCTION ops_top_statements(integer) SET search_path = pg_catalog, extensions;

-- Check: expect 14 categories, work_mem on the overlap function, restore gone.
SELECT array_length(nurture_excluded_categories(), 1) AS categories,
       (SELECT proconfig FROM pg_proc WHERE proname = 'nurture_email_other_tags') AS overlap_settings,
       (SELECT count(*) FROM pg_proc WHERE proname = 'nurture_queue_restore') AS restore_left;
