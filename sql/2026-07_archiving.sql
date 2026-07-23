-- ============================================================================
-- Active / Archived split (ReplyRouter spec §2–4).
--
-- Keeps EXACT counts fast at any scale by bounding what the active inbox
-- counts: the active set = Open Response (any age) + recently-categorized
-- (< 15 days out of Open Response). Everything older is archived (same table,
-- out of the hot path) and stays fully searchable/restorable in the Archive UI.
--
-- Run steps 1–4 first (these run in the Supabase SQL editor; the index builds
-- take a few seconds and briefly lock writes at this table size). If any single
-- statement hits the editor's ~2-min timeout, run that statement on its own.
-- Run step 5 (the initial backfill) only once the Archive UI is live, since it
-- hides rows from the active inbox.
-- ============================================================================

-- 1) Flags + reply-BCC capture ----------------------------------------------
ALTER TABLE replies ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE replies ADD COLUMN IF NOT EXISTS archived_at timestamptz;
-- The reply's own To/CC are already stored (to_*, prospect_cc_*). Bison also
-- sends the reply's bcc (almost always empty for inbound mail); capture it too.
ALTER TABLE replies ADD COLUMN IF NOT EXISTS prospect_bcc_email text;
ALTER TABLE replies ADD COLUMN IF NOT EXISTS prospect_bcc_name text;

-- 2) Active partial indexes (mirror the inbox indexes, scoped to archived=false)
--    so counts + leads over the active set are index-only, exact, and fast.
CREATE INDEX IF NOT EXISTS idx_replies_active_cherry_leads
  ON replies (client_tag, ai_categorized_lead_category, created_at DESC)
  WHERE archived = false AND inbox_is_noise = false;
CREATE INDEX IF NOT EXISTS idx_replies_active_master_leads
  ON replies (client_tag, lead_category, created_at DESC)
  WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_replies_active_leadcat
  ON replies (lead_category)
  WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_replies_active_cherry_leadcat
  ON replies (lead_category)
  WHERE archived = false AND inbox_is_noise = false
    AND ai_categorized_lead_category IN
      ('Interested','Meeting Request','Follow Up at a Later Date','Referral Given','Internally Forwarded','Unrecognizable by AI');
-- Archive-view search: date-ordered over archived rows.
CREATE INDEX IF NOT EXISTS idx_replies_archived_created
  ON replies (created_at DESC)
  WHERE archived = true;

-- 3) Counts RPC — same signature, now excludes archived rows so active counts
--    stay exact + cheap. (Old callers are unaffected: signature is unchanged.)
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
  sql text := 'SELECT COALESCE(lead_category, ''(uncategorized)'') AS lead_category, COUNT(*)::bigint AS n FROM replies WHERE archived = false';
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

ANALYZE replies;

-- 4) (Optional) archive-search counts helper — counts over ARCHIVED rows for
--    the Archive view (mirror of the above, archived = true).
CREATE OR REPLACE FUNCTION archive_category_counts(
  p_client_tag    text    DEFAULT NULL,
  p_allowed_tags  text[]  DEFAULT NULL,
  p_search        text    DEFAULT NULL
)
RETURNS TABLE (lead_category text, n bigint)
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  sql text := 'SELECT COALESCE(lead_category, ''(uncategorized)'') AS lead_category, COUNT(*)::bigint AS n FROM replies WHERE archived = true';
BEGIN
  IF p_client_tag IS NOT NULL THEN
    sql := sql || format(' AND client_tag = %L', p_client_tag);
  ELSIF p_allowed_tags IS NOT NULL THEN
    sql := sql || format(' AND client_tag = ANY(%L::text[])', p_allowed_tags);
  END IF;
  IF p_search IS NOT NULL THEN
    sql := sql || format(
      ' AND (lead_email ILIKE %L OR company_name ILIKE %L OR lead_name ILIKE %L OR reply_we_got ILIKE %L)',
      '%'||p_search||'%','%'||p_search||'%','%'||p_search||'%','%'||p_search||'%');
  END IF;
  sql := sql || ' GROUP BY COALESCE(lead_category, ''(uncategorized)'')';
  RETURN QUERY EXECUTE sql;
END;
$$;

-- 5) INITIAL ARCHIVE (run ONCE, after the Archive UI is live). Archives every
--    processed reply that's been out of Open Response for > 15 days; Open
--    Response stays active regardless of age. Uses categorized_at when known,
--    else falls back to updated_at/created_at for historical rows. Run over a
--    DIRECT connection; batch if it locks too long.
--
-- UPDATE replies SET archived = true, archived_at = now()
-- WHERE archived = false
--   AND lead_category IS NOT NULL
--   AND lead_category <> 'Open Response'
--   AND COALESCE(categorized_at, updated_at, created_at) < now() - interval '15 days';
