-- Single-query inbox category counts.
--
-- Replaces 20 parallel HEAD count queries (each re-planning the 32-clause
-- cherry view NOT ILIKE chain) with ONE GROUP BY query that the planner
-- evaluates once.
--
-- Returns one row per lead_category present in the filtered set; NULL
-- categories collapse to '(uncategorized)' so the caller never gets a
-- null key.
--
-- All filter params are nullable; pass NULL to skip that filter.
-- p_view = 'base-clients-cherry' applies the curated cherry exclude list.
-- Any other value (or NULL) skips the view filter entirely.

CREATE OR REPLACE FUNCTION inbox_category_counts(
  p_client_tag    text   DEFAULT NULL,
  p_allowed_tags  text[] DEFAULT NULL,
  p_workflow      text   DEFAULT NULL,
  p_search        text   DEFAULT NULL,
  p_view          text   DEFAULT NULL
)
RETURNS TABLE (lead_category text, n bigint)
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT
    COALESCE(lead_category, '(uncategorized)') AS lead_category,
    COUNT(*)::bigint AS n
  FROM replies
  WHERE
    (p_client_tag IS NULL OR client_tag = p_client_tag)
    AND (p_allowed_tags IS NULL OR client_tag = ANY(p_allowed_tags))
    AND (p_workflow IS NULL OR workflow = p_workflow)
    AND (p_search IS NULL OR (
      lead_email   ILIKE '%' || p_search || '%'
      OR company_name ILIKE '%' || p_search || '%'
      OR lead_name    ILIKE '%' || p_search || '%'
    ))
    AND (
      p_view IS NULL
      OR p_view <> 'base-clients-cherry'
      OR (
        -- reply body excludes (mirror of lib/inbox-views.ts cherry view)
        (reply_we_got IS NULL OR (
              reply_we_got NOT ILIKE '%could not be delivered%'
          AND reply_we_got NOT ILIKE '%DMARC%'
          AND reply_we_got NOT ILIKE '%Error message%'
          AND reply_we_got NOT ILIKE '%This is the mail system%'
          AND reply_we_got NOT ILIKE '%automated message%'
          AND reply_we_got NOT ILIKE '%I wasn''t able to%'
          AND reply_we_got NOT ILIKE '%Failed to deliver%'
          AND reply_we_got NOT ILIKE '%Permanent fatal%'
          AND reply_we_got NOT ILIKE '%Permanent error%'
          AND reply_we_got NOT ILIKE '%couldn''t be delivered%'
          AND reply_we_got NOT ILIKE '%delivery has failed%'
          AND reply_we_got NOT ILIKE '%temporary problem%'
          AND reply_we_got NOT ILIKE '%not delivered%'
          AND reply_we_got NOT ILIKE '%empty response%'
          AND reply_we_got NOT ILIKE '%please try again%'
          AND reply_we_got NOT ILIKE '%Error Type%'
          AND reply_we_got NOT ILIKE '%undeliverable%'
          AND reply_we_got NOT ILIKE '%address not found%'
          AND reply_we_got NOT ILIKE '%to postmaster%'
          AND reply_we_got NOT ILIKE '%message blocked%'
          AND reply_we_got NOT ILIKE '%Address not reachable%'
          AND reply_we_got NOT ILIKE '%Delivery Status Notification%'
          AND reply_we_got NOT ILIKE '%sah28aj19%'
        ))
        -- lead_email excludes
        AND (lead_email IS NULL OR (
              lead_email NOT ILIKE '%inbox%'
          AND lead_email NOT ILIKE '%dmarc%'
          AND lead_email NOT ILIKE '%daemon%'
          AND lead_email NOT ILIKE '%postmaster%'
          AND lead_email NOT ILIKE '%alignable.com%'
          AND lead_email NOT ILIKE '%hyperscale1.site%'
          AND lead_email NOT ILIKE '%voltic%'
        ))
        -- to_email excludes
        AND (to_email IS NULL OR to_email NOT ILIKE '%inbox%')
        -- email_subject excludes
        AND (email_subject IS NULL OR email_subject NOT ILIKE '%OutboundHero Cold%')
        -- aiCategoryAny: must match at least one
        AND (
          ai_categorized_lead_category = 'Interested'
          OR ai_categorized_lead_category = 'Meeting Request'
          OR ai_categorized_lead_category ILIKE '%Follow Up%'
          OR ai_categorized_lead_category ILIKE '%Unrecognizable%'
          OR ai_categorized_lead_category ILIKE '%Referral Given%'
          OR ai_categorized_lead_category ILIKE '%Quote%'
        )
      )
    )
  GROUP BY COALESCE(lead_category, '(uncategorized)');
$$;
