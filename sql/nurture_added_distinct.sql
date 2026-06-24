-- Exact count of DISTINCT leads (by email) a client has had pushed to a nurture
-- campaign. The "ADDED" tile previously summed COUNT(*) across sources, which
-- over-counts: one lead that finished several sequences has several
-- nurture_sequence_finished rows. Bison holds one lead per email, so the
-- accurate "added" number is the distinct-email count across all added sources.
--
-- Deploy: run this in the Supabase SQL editor (same as sql/inbox_category_counts.sql).
-- Used by GET /api/nurture/counts (per-client view).

create or replace function nurture_added_distinct(tag text)
returns integer
language sql
stable
as $$
  select count(distinct email)::int
  from (
    select lower(email) as email
      from nurture_sequence_finished
      where client_tag = tag and added_at is not null and email is not null and email <> ''
    union
    select lower(lead_email)
      from replies
      where client_tag = tag and nurture_added_at is not null and lead_email is not null and lead_email <> ''
    union
    select lower(lead_email)
      from nurture_legacy_leads
      where client_tag = tag and nurture_added_at is not null and lead_email is not null and lead_email <> ''
  ) u;
$$;
