/**
 * Airtable Automation — "Run script" action
 * ------------------------------------------------------------------
 * Mirrors an Airtable "Lead Category" mark to the originating Bison
 * workspace (Interested / Meeting-Ready Lead / Follow Up → interested;
 * Do Not Contact → unsubscribe) by calling the Reply Router endpoint
 * POST /api/bison/mark-status. Bison tokens stay on the server — this
 * script only carries the shared secret.
 *
 * ── ONE-TIME SETUP (per base) ─────────────────────────────────────
 * Airtable's API cannot create automations, so add this once per base:
 *
 * 1. Automations → Create automation.
 * 2. Trigger: "When a record matches conditions"
 *      Table: the replies table
 *      Condition:  Lead Category  is any of
 *        Interested, Meeting-Ready Lead, Follow Up, Do Not Contact
 * 3. Action: "Run a script". Paste this file.
 * 4. In the script step's left "Input variables" panel add THREE, each
 *    from the trigger record (Insert → Record → field):
 *      replyId   →  field "Reply ID"
 *      instance  →  field "Bison Instance"   (leave blank if the base
 *                   has no such column — the server resolves it)
 *      category  →  field "Lead Category"
 * 5. Set REPLY_ROUTER_URL and SECRET below.
 * 6. Test, then turn the automation ON.
 * ------------------------------------------------------------------
 */

// EDIT THESE TWO:
const REPLY_ROUTER_URL = "https://YOUR-REPLY-ROUTER-DOMAIN"; // e.g. https://replies.outboundhero.co
const SECRET = "YOUR_AIRTABLE_SYNC_SECRET"; // = AIRTABLE_SYNC_SECRET in Vercel

const { replyId, instance, category } = input.config();

if (!replyId) {
  console.log("No Reply ID on this record — skipping.");
} else {
  const res = await fetch(`${REPLY_ROUTER_URL}/api/bison/mark-status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-webhook-secret": SECRET,
    },
    body: JSON.stringify({ replyId, instance, category }),
  });

  let out;
  try { out = await res.json(); } catch { out = { error: await res.text() }; }
  console.log("mark-status →", res.status, out);

  // Fail the run (visible in the automation run log) if Bison rejected it,
  // but ignore "skipped" (category not synced) which is a normal 200.
  if (!res.ok) {
    throw new Error(`Bison sync failed (${res.status}): ${out && out.error ? out.error : "unknown"}`);
  }
}
