-- ════════════════════════════════════════════════════════════════════════════
-- Nurture redesign — patch 1 (2026-10-09). Applies on top of the already-run
-- sql/2026-10_nurture_redesign.sql. Safe to re-run.
--   • precise Undo: remove returns the exact row ids it flagged, and only ever
--     flags the contact's actual queue rows; nurture_queue_restore_rows undoes
--     exactly those rows.
--   • "Ready" = past cooldown + safe + confirmed ESP (what auto-push routes);
--     cooling / held classified per contact across all its rows.
--   • queue tab order: ready first, then soonest eligible, held last.
--   • stats count personal mailbox domains (gmail.com …) so the overview filter
--     is instant instead of a full scan; stats get a 120s timeout.
--   • index for the sequence-finished sync's duplicate check (it was timing
--     out on every run and scanning ~5.5M rows).
--
-- Supabase SQL editor:
--   STEP 1 — run the CREATE INDEX CONCURRENTLY statement ON ITS OWN (can't run
--            inside a transaction; builds without locking writes — may take a
--            few minutes on the 5.5M-row table).
--   STEP 2 — run everything from "STEP 2" to the end in one go.
-- ════════════════════════════════════════════════════════════════════════════

-- ── STEP 1 (run alone) ──────────────────────────────────────────────────────
-- The sequence-finished sync's "already known?" check looks rows up by
-- (client_tag, email) on every run — without this it scans the ~5.5M-row table
-- and times out (lib/nurture/sync-sequence-finished.ts).
CREATE INDEX CONCURRENTLY IF NOT EXISTS nurture_seq_tag_email_idx
  ON nurture_sequence_finished (client_tag, email);

-- ── STEP 2 (run together) ───────────────────────────────────────────────────

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

-- Per-tag numbers for the client page + overview (one JSON object).
CREATE OR REPLACE FUNCTION nurture_tag_stats(p_tag text, p_ignore_tags text[] DEFAULT '{}')
RETURNS jsonb LANGUAGE sql STABLE
SET statement_timeout = '120s'
AS $$
  WITH c AS (SELECT * FROM nurture_queue_contacts(p_tag)),
  ov AS (SELECT count(*)::int AS n FROM nurture_email_other_tags(p_tag, ARRAY(SELECT c.email FROM c), p_ignore_tags)),
  days AS (SELECT generate_series(0, 29) AS d),
  fc AS (
    SELECT d.d, count(c.email)::int AS n
    FROM days d
    LEFT JOIN c ON NOT c.is_eligible
               AND floor(extract(epoch FROM (c.eligible_at - now())) / 86400)::int = d.d
    GROUP BY d.d
  )
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
    'overlap',       (SELECT ov.n FROM ov),
    'last_new_at',   (SELECT max(c.trigger_at) FROM c),
    'computed_at',   now()
  )
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

REVOKE ALL ON FUNCTION nurture_queue_restore_rows(text, bigint[], bigint[], bigint[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION nurture_queue_restore_rows(text, bigint[], bigint[], bigint[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION nurture_queue_restore_rows(text, bigint[], bigint[], bigint[]) TO service_role;
