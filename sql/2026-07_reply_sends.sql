-- Sent-reply history + send-failure tracking for the inbox (Send Reply item 2).
-- Run in the Supabase SQL editor.

-- 1) Per-send history: one row per Send-Reply attempt (success OR failure), so
--    the inbox can show the full outbound history and retry failed sends.
CREATE TABLE IF NOT EXISTS reply_sends (
  id            bigserial PRIMARY KEY,
  reply_row_id  bigint NOT NULL,               -- replies.id this send belongs to
  client_tag    text,
  lead_email    text,
  sender_email  text,
  message       text,                          -- the exact body we sent
  to_json       jsonb,                         -- [{name,email}]
  cc_json       jsonb,
  bcc_json      jsonb,
  status        text NOT NULL,                 -- 'sent' | 'failed'
  error         text,                          -- populated when status='failed'
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reply_sends_row ON reply_sends (reply_row_id, created_at DESC);

-- 2) Latest send-failure marker on the reply itself, so a failed send stays
--    visible on the lead in the inbox until the next successful send clears it.
ALTER TABLE replies ADD COLUMN IF NOT EXISTS send_error text;
ALTER TABLE replies ADD COLUMN IF NOT EXISTS send_error_at timestamptz;
ALTER TABLE replies ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;

-- 3) Enriched audit outputs (city/state/industry) so the embedded
--    "Find Best Fit Client" matcher can auto-populate without a new AI call.
ALTER TABLE replies ADD COLUMN IF NOT EXISTS audit_city text;
ALTER TABLE replies ADD COLUMN IF NOT EXISTS audit_state text;
ALTER TABLE replies ADD COLUMN IF NOT EXISTS audit_industry text;
