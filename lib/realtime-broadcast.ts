/**
 * Server-side Supabase Broadcast for inbox realtime.
 *
 * We can't use client-side `postgres_changes` on `replies` anymore: that needs
 * the anon key to read the table, and RLS now (correctly) denies anon all access
 * — the anon key was publicly exposed in the browser bundle. Broadcast is a
 * pub/sub channel that does NOT touch table RLS, so it's safe.
 *
 * The payload is deliberately MINIMAL and NON-PII (client tag + the few fields
 * the client needs to decide view membership) — the broadcast channel is open,
 * so it must never carry lead identity or reply content. The client uses it only
 * as a "something changed" signal and re-fetches through the authenticated
 * /api/inbox route (service-role, scope-enforced).
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOPIC = "inbox-realtime";

export interface ReplyChangeSignal {
  client_tag: string | null;
  lead_category: string | null;
  ai_categorized_lead_category: string | null;
  inbox_is_noise: boolean;
}

/** Broadcast a "a reply changed" signal to the inbox channel. Best-effort. */
export async function broadcastReplyChange(signal: ReplyChangeSignal): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({
        messages: [{ topic: TOPIC, event: "reply-change", payload: signal, private: false }],
      }),
    });
  } catch {
    /* realtime is a nicety — never let a broadcast failure affect ingest */
  }
}
