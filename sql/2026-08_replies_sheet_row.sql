-- ============================================================================
-- "Lead handoff email" support: remember exactly which Google-Sheet row we
-- appended for each lead, so the send-reply flow can update THAT row's
-- "Lead handoff email" cell (Option B) instead of guessing by email.
--
-- Both writes are best-effort in code — until this runs, the handoff writer
-- simply falls back to email-matching (Option A). Instant, safe to run anytime.
-- ============================================================================

ALTER TABLE replies ADD COLUMN IF NOT EXISTS sheet_row integer;
ALTER TABLE replies ADD COLUMN IF NOT EXISTS sheet_id  text;
