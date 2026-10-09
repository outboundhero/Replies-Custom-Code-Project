-- ════════════════════════════════════════════════════════════════════════════
-- Nurture System redesign (approved mockup, 2026-10) — queue paging with filters,
-- per-tag stats, cross-tag overlap and bulk remove, computed IN the database
-- (the queues hold ~1.5M pending contacts; paging them through the REST API
-- is far too slow).
--
-- Definitions match the existing nurture logic exactly:
--   • queue (pending) = not yet added to a nurture campaign, not skipped
--     (+ for replies/legacy: has a reply, AI category not hard-blocked) —
--     same filters as nurture_clients_summary().
--   • a CONTACT is one email per client tag (a lead with several rows — e.g. it
--     finished two sequences — counts once); its eligibility comes from its
--     earliest trigger (reply_time / sequence_finished_at / reply_at).
--   • eligible = trigger ≥ 45 days ago; ready = eligible AND safe
--     (sequence-finished rows are always safe) — same as the "Ready" tile.
--   • ESP bucket = lib/nurture/esp.ts effectiveEsp(): stored host → outlook /
--     segs / google, else the consumer-Microsoft-domain heuristic.
--   • overlap = the same email is ALSO pending in another client tag's queue.
--   • remove = the existing nurture "skip" flag (reversible; never touches Bison).
--
-- Deploy (Supabase SQL editor):
--   STEP 1 — run each CREATE INDEX CONCURRENTLY statement below ON ITS OWN
--            (they can't run inside a transaction; CONCURRENTLY = no write lock
--            on the live tables, safe while webhooks are writing).
--   STEP 2 — run everything from "STEP 2" to the end in one go.
-- ════════════════════════════════════════════════════════════════════════════

-- ── STEP 1: indexes (run one at a time) ─────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS nurture_seq_pending_tag_idx
  ON nurture_sequence_finished (client_tag, sequence_finished_at)
  WHERE added_at IS NULL AND skipped IS NOT TRUE;

CREATE INDEX CONCURRENTLY IF NOT EXISTS nurture_seq_pending_email_idx
  ON nurture_sequence_finished (lower(email))
  WHERE added_at IS NULL AND skipped IS NOT TRUE;

CREATE INDEX CONCURRENTLY IF NOT EXISTS replies_nurture_pending_tag_idx
  ON replies (client_tag, reply_time)
  WHERE nurture_added_at IS NULL AND nurture_skipped IS NOT TRUE AND reply_time IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS replies_nurture_pending_email_idx
  ON replies (lower(lead_email))
  WHERE nurture_added_at IS NULL AND nurture_skipped IS NOT TRUE AND reply_time IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS nurture_legacy_pending_tag_idx
  ON nurture_legacy_leads (client_tag, reply_at)
  WHERE nurture_added_at IS NULL AND nurture_skipped IS NOT TRUE;

CREATE INDEX CONCURRENTLY IF NOT EXISTS nurture_legacy_pending_email_idx
  ON nurture_legacy_leads (lower(lead_email))
  WHERE nurture_added_at IS NULL AND nurture_skipped IS NOT TRUE;

-- The sequence-finished sync's "already known?" check looks rows up by
-- (client_tag, email) on every run — without this it scans the ~5.5M-row table
-- and times out (lib/nurture/sync-sequence-finished.ts).
CREATE INDEX CONCURRENTLY IF NOT EXISTS nurture_seq_tag_email_idx
  ON nurture_sequence_finished (client_tag, email);

-- ── STEP 2: functions (run together) ────────────────────────────────────────

-- Re-runnable: drop first so a changed return shape never blocks CREATE.
DROP FUNCTION IF EXISTS nurture_tags_with_suffix(text, text, text[]);
DROP FUNCTION IF EXISTS nurture_queue_restore_rows(text, bigint[], bigint[], bigint[]);
DROP FUNCTION IF EXISTS nurture_queue_restore(text, text[]);
DROP FUNCTION IF EXISTS nurture_queue_remove(text, text[], boolean, text, text, text, text, text, boolean, text[]);
DROP FUNCTION IF EXISTS nurture_tag_overlap(text, text[]);
DROP FUNCTION IF EXISTS nurture_tag_stats(text, text[]);
DROP FUNCTION IF EXISTS nurture_queue_page(text, text, text, text, text, text, boolean, text[], integer, integer);
DROP FUNCTION IF EXISTS nurture_queue_filtered(text, text, text, text, text, text, boolean, text[]);
DROP FUNCTION IF EXISTS nurture_email_other_tags(text, text[], text[]);
DROP FUNCTION IF EXISTS nurture_queue_contacts(text);
DROP FUNCTION IF EXISTS nurture_queue_base(text);
DROP FUNCTION IF EXISTS nurture_seq_site(jsonb);
DROP FUNCTION IF EXISTS nurture_contact_site(text, text);
DROP FUNCTION IF EXISTS nurture_domain_endings(text);
DROP FUNCTION IF EXISTS nurture_personal_domains();

-- Hard-blocked AI categories (same list as nurture_clients_summary + /api/nurture).
CREATE OR REPLACE FUNCTION nurture_excluded_categories()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'Interested','Meeting Request','Meeting Set','Do Not Contact',
    'Wrong Person','Wrong Person (Change of Target)','Not Interested',
    'Mailbox No Longer Active','Automated Error Message',
    'Automated Catch-All Message','Referral Given','Internally Forwarded'
  ]::text[]
$$;

-- lib/nurture/esp.ts effectiveEsp(): stored host wins, else consumer-domain heuristic.
CREATE OR REPLACE FUNCTION nurture_esp_bucket(p_host text, p_email text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_host IS NULL OR btrim(p_host) = '' THEN
      CASE WHEN lower(btrim(split_part(p_email, '@', 2))) = ANY (ARRAY[
        'outlook.com','hotmail.com','live.com','msn.com','passport.com',
        'outlook.co.uk','hotmail.co.uk','live.co.uk','outlook.fr','hotmail.fr','live.fr',
        'outlook.de','hotmail.de','live.de','outlook.it','hotmail.it','outlook.es','hotmail.es',
        'outlook.com.au','hotmail.com.au','outlook.jp','microsoft.com','office.com'])
      THEN 'outlook' ELSE 'google' END
    WHEN lower(btrim(p_host)) IN ('google','outlook','segs') THEN lower(btrim(p_host))
    WHEN lower(p_host) ~ '(outlook|office 365|office365|microsoft|exchange|hotmail)' THEN 'outlook'
    WHEN lower(p_host) ~ '(mimecast|barracuda|proofpoint|cisco|ironport|fortinet|fortimail|sophos|trend micro)' THEN 'segs'
    ELSE 'google'
  END
$$;

-- Normalise a website / domain for display + "ends with" matching:
-- "https://www.Acme.com/" → "acme.com".
CREATE OR REPLACE FUNCTION nurture_norm_site(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(rtrim(regexp_replace(lower(btrim(coalesce(p, ''))), '^(https?://)?(www\.)?', ''), '/'), '')
$$;

-- A contact's website: the stored site (normalised), else its email's domain —
-- unless that's a personal mailbox provider (gmail.com etc. isn't a website).
CREATE OR REPLACE FUNCTION nurture_contact_site(p_site text, p_email text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    nurture_norm_site(p_site),
    CASE WHEN lower(split_part(p_email, '@', 2)) = ANY (ARRAY[
           'gmail.com','googlemail.com','yahoo.com','yahoo.ca','ymail.com','rocketmail.com',
           'aol.com','aim.com','outlook.com','hotmail.com','hotmail.ca','live.com','msn.com',
           'icloud.com','me.com','mac.com','att.net','comcast.net','xfinity.com','verizon.net',
           'sbcglobal.net','bellsouth.net','cox.net','charter.net','spectrum.net',
           'protonmail.com','proton.me','fastmail.com','zoho.com','gmx.com','mail.com'])
         THEN NULL ELSE nurture_norm_site(split_part(p_email, '@', 2)) END
  )
$$;

-- The website stored on a sequence-finished row (Bison custom variable).
CREATE OR REPLACE FUNCTION nurture_seq_site(p_vars jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(btrim(e ->> 'value'), '')
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_vars) = 'array' THEN p_vars ELSE '[]'::jsonb END) e
  WHERE lower(e ->> 'name') IN ('domain', 'website', 'company website', 'company domain')
    AND NULLIF(btrim(e ->> 'value'), '') IS NOT NULL
  LIMIT 1
$$;

-- Personal mailbox providers (same list nurture_contact_site uses) — the
-- overview's "Email ends with gmail.com" etc. is answered from per-tag counts.
CREATE OR REPLACE FUNCTION nurture_personal_domains()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'gmail.com','googlemail.com','yahoo.com','yahoo.ca','ymail.com','rocketmail.com',
    'aol.com','aim.com','outlook.com','hotmail.com','hotmail.ca','live.com','msn.com',
    'icloud.com','me.com','mac.com','att.net','comcast.net','xfinity.com','verizon.net',
    'sbcglobal.net','bellsouth.net','cox.net','charter.net','spectrum.net',
    'protonmail.com','proton.me','fastmail.com','zoho.com','gmx.com','mail.com']
$$;

-- A domain's endings for "ends with" filtering: the last label (".com", ".in")
-- plus, for public second levels, the last two (".co.uk", ".com.au").
CREATE OR REPLACE FUNCTION nurture_domain_endings(p_domain text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN coalesce(btrim(p_domain), '') = '' THEN '{}'::text[] ELSE
    array_remove(ARRAY[
      substring(lower(btrim(p_domain)) from '(\.[a-z0-9-]+)$'),
      CASE WHEN lower(btrim(p_domain)) ~ '\.(co|com|org|net|gov|govt|edu|ac|ltd|plc|nic|mil|sch|nhs)\.[a-z0-9-]+$'
           THEN substring(lower(btrim(p_domain)) from '(\.[a-z0-9-]+\.[a-z0-9-]+)$') END
    ], NULL) END
$$;

-- Every PENDING queue row for one client tag, from the three sources.
CREATE OR REPLACE FUNCTION nurture_queue_base(p_tag text)
RETURNS TABLE (
  src text, row_id bigint, email text, first_name text, last_name text, company text,
  website text, source text, esp_host text, trigger_at timestamptz, safe boolean
)
LANGUAGE sql STABLE AS $$
  SELECT 'reply', r.id::bigint, lower(btrim(r.lead_email)), r.first_name, r.last_name, r.company_name,
         NULL::text,
         CASE r.nurture_bucket WHEN 'soft_negative' THEN 'soft' WHEN 'out_of_office' THEN 'ooo' ELSE 'other' END,
         r.esp, r.reply_time, coalesce(r.nurture_safety = 'safe', false)
  FROM replies r
  WHERE r.client_tag = p_tag
    AND r.nurture_added_at IS NULL AND r.nurture_skipped IS NOT TRUE AND r.reply_time IS NOT NULL
    AND r.reply_we_got IS NOT NULL AND r.reply_we_got <> ''
    AND (r.ai_categorized_lead_category IS NULL
         OR r.ai_categorized_lead_category <> ALL (nurture_excluded_categories()))
    AND coalesce(btrim(r.lead_email), '') <> ''
  UNION ALL
  SELECT 'seq', s.id::bigint, lower(btrim(s.email)), s.first_name, s.last_name, s.company,
         nurture_seq_site(s.custom_variables::jsonb),
         'seq', s.esp, s.sequence_finished_at, true
  FROM nurture_sequence_finished s
  WHERE s.client_tag = p_tag
    AND s.added_at IS NULL AND s.skipped IS NOT TRUE
    AND s.sequence_finished_at IS NOT NULL
    AND coalesce(btrim(s.email), '') <> ''
  UNION ALL
  SELECT 'legacy', l.id::bigint, lower(btrim(l.lead_email)), l.first_name, l.last_name, l.company,
         NULLIF(btrim(l.raw_fields::jsonb ->> 'website'), ''),
         CASE l.nurture_bucket WHEN 'soft_negative' THEN 'soft' WHEN 'out_of_office' THEN 'ooo' ELSE 'legacy' END,
         l.esp, l.reply_at, coalesce(l.nurture_safety = 'safe', false)
  FROM nurture_legacy_leads l
  WHERE l.client_tag = p_tag
    AND l.nurture_added_at IS NULL AND l.nurture_skipped IS NOT TRUE AND l.reply_at IS NOT NULL
    AND (l.original_ai_category IS NULL
         OR l.original_ai_category <> ALL (nurture_excluded_categories()))
    AND coalesce(btrim(l.lead_email), '') <> ''
$$;

-- One row per CONTACT (email) in the tag's queue. Its status follows what
-- auto-push (lib/nurture/auto-push.ts) will actually do:
--   ready   = some row is past the 45-day cooldown, safe, AND has a confirmed
--             ESP (auto-push holds unconfirmed-ESP rows back);
--   cooling = not ready, but a safe row is still cooling down → eligible_at is
--             when the earliest such row clears it;
--   held    = past the cooldown but nothing routable yet (not marked safe, or
--             ESP not confirmed).
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
         nurture_esp_bucket(f.esp_host, f.email),
         coalesce(btrim(f.esp_host), '') <> '',
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

-- Other client tags whose queue ALSO holds each of these emails (overlap).
-- p_ignore_tags: tags to disregard (e.g. churned clients).
CREATE OR REPLACE FUNCTION nurture_email_other_tags(p_tag text, p_emails text[], p_ignore_tags text[] DEFAULT '{}')
RETURNS TABLE (email text, tags text[])
LANGUAGE sql STABLE AS $$
  WITH hits AS (
    SELECT lower(r.lead_email) AS email, r.client_tag AS tag
    FROM replies r
    WHERE lower(r.lead_email) = ANY (p_emails)
      AND r.nurture_added_at IS NULL AND r.nurture_skipped IS NOT TRUE AND r.reply_time IS NOT NULL
      AND r.client_tag IS NOT NULL AND r.client_tag NOT IN ('N/A') AND r.client_tag <> p_tag
      AND r.client_tag <> ALL (coalesce(p_ignore_tags, '{}'))
      AND r.reply_we_got IS NOT NULL AND r.reply_we_got <> ''
      AND (r.ai_categorized_lead_category IS NULL
           OR r.ai_categorized_lead_category <> ALL (nurture_excluded_categories()))
    UNION
    SELECT lower(s.email), s.client_tag
    FROM nurture_sequence_finished s
    WHERE lower(s.email) = ANY (p_emails)
      AND s.added_at IS NULL AND s.skipped IS NOT TRUE AND s.sequence_finished_at IS NOT NULL
      AND s.client_tag IS NOT NULL AND s.client_tag NOT IN ('N/A') AND s.client_tag <> p_tag
      AND s.client_tag <> ALL (coalesce(p_ignore_tags, '{}'))
    UNION
    SELECT lower(l.lead_email), l.client_tag
    FROM nurture_legacy_leads l
    WHERE lower(l.lead_email) = ANY (p_emails)
      AND l.nurture_added_at IS NULL AND l.nurture_skipped IS NOT TRUE AND l.reply_at IS NOT NULL
      AND l.client_tag IS NOT NULL AND l.client_tag NOT IN ('N/A') AND l.client_tag <> p_tag
      AND l.client_tag <> ALL (coalesce(p_ignore_tags, '{}'))
      AND (l.original_ai_category IS NULL
           OR l.original_ai_category <> ALL (nurture_excluded_categories()))
  )
  SELECT h.email, array_agg(DISTINCT h.tag ORDER BY h.tag) FROM hits h GROUP BY h.email
$$;

-- The tag's queue contacts after the queue-tab filters (shared by paging + remove).
-- NULL / '' filter = not applied. p_source: seq | soft | ooo | other | legacy.
CREATE OR REPLACE FUNCTION nurture_queue_filtered(
  p_tag text, p_search text DEFAULT NULL, p_email_suffix text DEFAULT NULL,
  p_web_suffix text DEFAULT NULL, p_source text DEFAULT NULL, p_tld text DEFAULT NULL,
  p_overlap_only boolean DEFAULT false, p_ignore_tags text[] DEFAULT '{}'
)
RETURNS TABLE (
  email text, src text, row_id bigint, first_name text, last_name text, company text,
  website text, source text, esp text, esp_resolved boolean,
  trigger_at timestamptz, eligible_at timestamptz, is_eligible boolean, is_ready boolean,
  tld text, row_count integer
)
LANGUAGE sql STABLE AS $$
  WITH c AS (SELECT * FROM nurture_queue_contacts(p_tag)),
  f AS (
    SELECT c.* FROM c
    WHERE (NULLIF(btrim(p_search), '') IS NULL
           OR c.email ILIKE '%' || btrim(p_search) || '%'
           OR (coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) ILIKE '%' || btrim(p_search) || '%'
           OR coalesce(c.company, '') ILIKE '%' || btrim(p_search) || '%')
      AND (NULLIF(btrim(p_email_suffix), '') IS NULL OR c.email LIKE '%' || lower(btrim(p_email_suffix)))
      AND (NULLIF(btrim(p_web_suffix), '') IS NULL OR coalesce(c.website, '') LIKE '%' || lower(btrim(p_web_suffix)))
      AND (NULLIF(btrim(p_source), '') IS NULL OR c.source = p_source)
      AND (NULLIF(btrim(p_tld), '') IS NULL OR c.tld = lower(btrim(p_tld)))
  )
  SELECT f.* FROM f
  WHERE NOT coalesce(p_overlap_only, false)
     OR f.email IN (SELECT o.email FROM nurture_email_other_tags(p_tag, ARRAY(SELECT f2.email FROM f f2), p_ignore_tags) o)
$$;

-- One page of the queue tab + the total matching count. Order: ready to send
-- first, then cooling down (soonest eligible first), then held (eligible but
-- not marked safe — they never route) last.
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
    ORDER BY CASE WHEN f.is_ready THEN 0 WHEN NOT f.is_eligible THEN 1 ELSE 2 END, f.trigger_at ASC, f.email ASC
    LIMIT greatest(1, least(coalesce(p_limit, 50), 500)) OFFSET greatest(0, coalesce(p_offset, 0))
  ),
  ov AS (
    SELECT * FROM nurture_email_other_tags(p_tag, ARRAY(SELECT p.email FROM page p), p_ignore_tags)
  )
  SELECT p.email, p.src, p.row_id, p.first_name, p.last_name, p.company, p.website, p.source, p.esp,
         p.esp_resolved, p.trigger_at, p.eligible_at, p.is_eligible, p.is_ready, p.tld, p.row_count,
         coalesce(ov.tags, '{}'::text[]), p.total_count
  FROM page p LEFT JOIN ov ON ov.email = p.email
  ORDER BY CASE WHEN p.is_ready THEN 0 WHEN NOT p.is_eligible THEN 1 ELSE 2 END, p.trigger_at ASC, p.email ASC
$$;

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

-- Remove contacts from a tag's queue: sets the existing skip flags on EXACTLY
-- the rows that make up those contacts' queue entries (the same rules as the
-- queue itself, via nurture_queue_base — never an excluded / already-added /
-- unfinished row of the same email). Either an explicit email list, or
-- p_all_matching = true + the same filters as the queue tab. Returns the exact
-- row ids it flagged, so Undo restores precisely those rows.
CREATE OR REPLACE FUNCTION nurture_queue_remove(
  p_tag text, p_emails text[] DEFAULT NULL, p_all_matching boolean DEFAULT false,
  p_search text DEFAULT NULL, p_email_suffix text DEFAULT NULL, p_web_suffix text DEFAULT NULL,
  p_source text DEFAULT NULL, p_tld text DEFAULT NULL, p_overlap_only boolean DEFAULT false,
  p_ignore_tags text[] DEFAULT '{}'
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE
SET statement_timeout = '120s'
AS $$
DECLARE
  target text[]; flagged text[];
  q_reply bigint[]; q_seq bigint[]; q_legacy bigint[];
  ids_reply bigint[]; ids_seq bigint[]; ids_legacy bigint[];
  em_reply text[]; em_seq text[]; em_legacy text[];
BEGIN
  IF p_tag IS NULL OR btrim(p_tag) = '' THEN
    RAISE EXCEPTION 'p_tag is required';
  END IF;
  IF coalesce(p_all_matching, false) THEN
    SELECT array_agg(f.email) INTO target
    FROM nurture_queue_filtered(p_tag, p_search, p_email_suffix, p_web_suffix, p_source, p_tld, p_overlap_only, p_ignore_tags) f;
  ELSE
    SELECT array_agg(DISTINCT lower(btrim(x))) INTO target
    FROM unnest(coalesce(p_emails, '{}'::text[])) x WHERE coalesce(btrim(x), '') <> '';
  END IF;
  IF target IS NULL OR cardinality(target) = 0 THEN
    RETURN jsonb_build_object('contacts', 0, 'rows', 0, 'emails', '[]'::jsonb,
      'reply_ids', '[]'::jsonb, 'seq_ids', '[]'::jsonb, 'legacy_ids', '[]'::jsonb);
  END IF;

  -- The queue rows of these contacts (emails already lower(btrim()) like the queue's).
  SELECT coalesce(array_agg(b.row_id) FILTER (WHERE b.src = 'reply'), '{}'),
         coalesce(array_agg(b.row_id) FILTER (WHERE b.src = 'seq'), '{}'),
         coalesce(array_agg(b.row_id) FILTER (WHERE b.src = 'legacy'), '{}')
    INTO q_reply, q_seq, q_legacy
  FROM nurture_queue_base(p_tag) b
  WHERE b.email = ANY (target);

  WITH u AS (
    UPDATE replies SET nurture_skipped = true
     WHERE id = ANY (q_reply) AND client_tag = p_tag
       AND nurture_added_at IS NULL AND nurture_skipped IS NOT TRUE
    RETURNING id, lower(btrim(lead_email)) AS e
  ) SELECT coalesce(array_agg(u.id::bigint), '{}'), coalesce(array_agg(u.e), '{}') INTO ids_reply, em_reply FROM u;

  WITH u AS (
    UPDATE nurture_sequence_finished SET skipped = true
     WHERE id = ANY (q_seq) AND client_tag = p_tag
       AND added_at IS NULL AND skipped IS NOT TRUE
    RETURNING id, lower(btrim(email)) AS e
  ) SELECT coalesce(array_agg(u.id::bigint), '{}'), coalesce(array_agg(u.e), '{}') INTO ids_seq, em_seq FROM u;

  WITH u AS (
    UPDATE nurture_legacy_leads SET nurture_skipped = true
     WHERE id = ANY (q_legacy) AND client_tag = p_tag
       AND nurture_added_at IS NULL AND nurture_skipped IS NOT TRUE
    RETURNING id, lower(btrim(lead_email)) AS e
  ) SELECT coalesce(array_agg(u.id::bigint), '{}'), coalesce(array_agg(u.e), '{}') INTO ids_legacy, em_legacy FROM u;

  -- contacts = distinct emails that actually had a row flagged
  SELECT coalesce(array_agg(DISTINCT x), '{}') INTO flagged FROM unnest(em_reply || em_seq || em_legacy) x;

  RETURN jsonb_build_object(
    'contacts', cardinality(flagged),
    'rows', cardinality(ids_reply) + cardinality(ids_seq) + cardinality(ids_legacy),
    'emails', CASE WHEN cardinality(flagged) <= 5000 THEN to_jsonb(flagged) ELSE NULL END,
    'reply_ids', to_jsonb(ids_reply), 'seq_ids', to_jsonb(ids_seq), 'legacy_ids', to_jsonb(ids_legacy)
  );
END
$$;

-- Undo a remove by email (clears the skip flags for these emails in this tag).
-- Kept for manual use; the UI's Undo uses nurture_queue_restore_rows.
CREATE OR REPLACE FUNCTION nurture_queue_restore(p_tag text, p_emails text[])
RETURNS jsonb LANGUAGE plpgsql VOLATILE
SET statement_timeout = '60s'
AS $$
DECLARE
  target text[];
  n_reply int := 0; n_seq int := 0; n_legacy int := 0;
BEGIN
  SELECT array_agg(DISTINCT lower(btrim(x))) INTO target
  FROM unnest(coalesce(p_emails, '{}'::text[])) x WHERE coalesce(btrim(x), '') <> '';
  IF target IS NULL THEN RETURN jsonb_build_object('rows', 0); END IF;
  UPDATE replies SET nurture_skipped = false
   WHERE client_tag = p_tag AND lower(lead_email) = ANY (target) AND nurture_added_at IS NULL AND nurture_skipped IS TRUE;
  GET DIAGNOSTICS n_reply = ROW_COUNT;
  UPDATE nurture_sequence_finished SET skipped = false
   WHERE client_tag = p_tag AND lower(email) = ANY (target) AND added_at IS NULL AND skipped IS TRUE;
  GET DIAGNOSTICS n_seq = ROW_COUNT;
  UPDATE nurture_legacy_leads SET nurture_skipped = false
   WHERE client_tag = p_tag AND lower(lead_email) = ANY (target) AND nurture_added_at IS NULL AND nurture_skipped IS TRUE;
  GET DIAGNOSTICS n_legacy = ROW_COUNT;
  RETURN jsonb_build_object('rows', n_reply + n_seq + n_legacy);
END
$$;

-- Undo one specific remove: clears the skip flag on exactly the rows that
-- remove flagged (ids from nurture_queue_remove), still scoped to the tag and
-- only while the row hasn't been added since.
CREATE OR REPLACE FUNCTION nurture_queue_restore_rows(p_tag text, p_reply_ids bigint[], p_seq_ids bigint[], p_legacy_ids bigint[])
RETURNS jsonb LANGUAGE plpgsql VOLATILE
SET statement_timeout = '60s'
AS $$
DECLARE
  n_reply int := 0; n_seq int := 0; n_legacy int := 0;
BEGIN
  IF p_tag IS NULL OR btrim(p_tag) = '' THEN
    RAISE EXCEPTION 'p_tag is required';
  END IF;
  UPDATE replies SET nurture_skipped = false
   WHERE client_tag = p_tag AND id = ANY (coalesce(p_reply_ids, '{}')) AND nurture_added_at IS NULL AND nurture_skipped IS TRUE;
  GET DIAGNOSTICS n_reply = ROW_COUNT;
  UPDATE nurture_sequence_finished SET skipped = false
   WHERE client_tag = p_tag AND id = ANY (coalesce(p_seq_ids, '{}')) AND added_at IS NULL AND skipped IS TRUE;
  GET DIAGNOSTICS n_seq = ROW_COUNT;
  UPDATE nurture_legacy_leads SET nurture_skipped = false
   WHERE client_tag = p_tag AND id = ANY (coalesce(p_legacy_ids, '{}')) AND nurture_added_at IS NULL AND nurture_skipped IS TRUE;
  GET DIAGNOSTICS n_legacy = ROW_COUNT;
  RETURN jsonb_build_object('rows', n_reply + n_seq + n_legacy);
END
$$;

-- Overview filters "email ends with" / "website ends with": which tags' queues
-- contain a matching contact (distinct contacts per tag). One pass over the
-- pending rows (not per-tag) so it stays fast on the full ~1.5M-row queue.
CREATE OR REPLACE FUNCTION nurture_tags_with_suffix(p_email_suffix text DEFAULT NULL, p_web_suffix text DEFAULT NULL, p_tags text[] DEFAULT NULL)
RETURNS TABLE (client_tag text, n bigint)
LANGUAGE sql STABLE
SET statement_timeout = '120s'
AS $$
  WITH es AS (SELECT lower(NULLIF(btrim(p_email_suffix), '')) AS e, lower(NULLIF(btrim(p_web_suffix), '')) AS w),
  hits AS (
    SELECT r.client_tag AS tag, lower(btrim(r.lead_email)) AS email, NULL::text AS site
    FROM replies r, es
    WHERE r.nurture_added_at IS NULL AND r.nurture_skipped IS NOT TRUE AND r.reply_time IS NOT NULL
      AND r.reply_we_got IS NOT NULL AND r.reply_we_got <> ''
      AND (r.ai_categorized_lead_category IS NULL OR r.ai_categorized_lead_category <> ALL (nurture_excluded_categories()))
      AND r.client_tag IS NOT NULL AND r.client_tag <> 'N/A' AND coalesce(btrim(r.lead_email), '') <> ''
      AND (p_tags IS NULL OR r.client_tag = ANY (p_tags))
      AND (es.e IS NULL OR lower(btrim(r.lead_email)) LIKE '%' || es.e)
    UNION ALL
    SELECT s.client_tag, lower(btrim(s.email)), CASE WHEN es.w IS NULL THEN NULL ELSE nurture_seq_site(s.custom_variables::jsonb) END
    FROM nurture_sequence_finished s, es
    WHERE s.added_at IS NULL AND s.skipped IS NOT TRUE AND s.sequence_finished_at IS NOT NULL
      AND s.client_tag IS NOT NULL AND s.client_tag <> 'N/A' AND coalesce(btrim(s.email), '') <> ''
      AND (p_tags IS NULL OR s.client_tag = ANY (p_tags))
      AND (es.e IS NULL OR lower(btrim(s.email)) LIKE '%' || es.e)
    UNION ALL
    SELECT l.client_tag, lower(btrim(l.lead_email)), CASE WHEN es.w IS NULL THEN NULL ELSE NULLIF(btrim(l.raw_fields::jsonb ->> 'website'), '') END
    FROM nurture_legacy_leads l, es
    WHERE l.nurture_added_at IS NULL AND l.nurture_skipped IS NOT TRUE AND l.reply_at IS NOT NULL
      AND (l.original_ai_category IS NULL OR l.original_ai_category <> ALL (nurture_excluded_categories()))
      AND l.client_tag IS NOT NULL AND l.client_tag <> 'N/A' AND coalesce(btrim(l.lead_email), '') <> ''
      AND (p_tags IS NULL OR l.client_tag = ANY (p_tags))
      AND (es.e IS NULL OR lower(btrim(l.lead_email)) LIKE '%' || es.e)
  )
  SELECT h.tag, count(DISTINCT h.email)
  FROM hits h, es
  WHERE es.w IS NULL OR coalesce(nurture_contact_site(h.site, h.email), '') LIKE '%' || es.w
  GROUP BY h.tag
$$;

-- Lock the functions to the server (service role) — never callable with the
-- public anon key.
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'nurture_queue_base(text)', 'nurture_queue_contacts(text)',
    'nurture_email_other_tags(text, text[], text[])',
    'nurture_queue_filtered(text, text, text, text, text, text, boolean, text[])',
    'nurture_queue_page(text, text, text, text, text, text, boolean, text[], integer, integer)',
    'nurture_tag_stats(text, text[])',
    'nurture_tag_overlap(text, text[])',
    'nurture_queue_remove(text, text[], boolean, text, text, text, text, text, boolean, text[])',
    'nurture_queue_restore(text, text[])',
    'nurture_queue_restore_rows(text, bigint[], bigint[], bigint[])',
    'nurture_tags_with_suffix(text, text, text[])'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    BEGIN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', fn); EXCEPTION WHEN undefined_object THEN NULL; END;
    BEGIN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn); EXCEPTION WHEN undefined_object THEN NULL; END;
  END LOOP;
END $$;
