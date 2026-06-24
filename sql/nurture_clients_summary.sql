-- Per-client nurture headline counts for the hub (Overview cards + global tiles).
--
-- "added" is the DISTINCT-email count of leads pushed to a campaign (Bison holds
-- one lead per email; a lead that finished several sequences has several
-- nurture_sequence_finished rows and must not be counted multiple times).
-- ready / eligible / waiting stay as row sums (consistent with the drill-page
-- counts endpoint).
--
-- Deploy: run in the Supabase SQL editor (same as sql/inbox_category_counts.sql).
-- Used by GET /api/nurture/clients-summary and the refresh-nurture-summary cron.

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
      'Automated Catch-All Message','Referral Given','Internally Forwarded'
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
