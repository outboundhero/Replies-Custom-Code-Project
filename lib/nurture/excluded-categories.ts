/**
 * Lead categories that DISQUALIFY a row from the nurture queue — one list for
 * every nurture path (auto-push, the classic queue / ids / counts routes, the
 * ESP backfill, the safety classifier). The database mirrors it in
 * nurture_excluded_categories() and nurture_clients_summary() (sql/).
 *
 * Two reasons to block:
 *
 * (a) Already-engaged (a nurture sequence here would step on an active
 *     conversation handled by sales/CS): Interested, Meeting Request,
 *     Meeting Set, Meeting-Ready Lead.
 *
 * (b) Definitively-not-contactable (already opted out, wrong contact, handed
 *     off, or not a human at all).
 *
 * Categories that REMAIN nurture candidates (decided by the reply-text safety
 * classifier, not hard-blocked): Out Of Office, Follow Up at a Later Date,
 * Open Response, Unrecognizable by AI.
 *
 * Includes both the AI-Categorized variant ("Meeting Request") and the human
 * Lead-Category variant ("Meeting Set") because the import maps either to
 * original_ai_category.
 */
export const NURTURE_EXCLUDED_AI_CATEGORIES: readonly string[] = [
  // Hot leads — already engaged, nurture would interfere
  "Interested",
  "Meeting Request",
  "Meeting Set",
  // Meeting-Ready Lead is the system's most common hot-lead category (CC/BCC
  // known-client match + AI). These were delivered to the client as interested
  // leads — nurturing them again re-targets a lead sales already owns.
  "Meeting-Ready Lead",
  "Meeting Ready Lead",
  // Hard opt-outs / bad contacts
  "Do Not Contact",
  "Wrong Person",
  "Wrong Person (Change of Target)",
  "Not Interested",
  // Dead mailboxes / bots
  "Mailbox No Longer Active",
  "Automated Error Message",
  "Automated Catch-All Message",
  // Lead has handed us off — original address is no longer the right
  // recipient, so nurture would be pointless or rude.
  "Referral Given",
  "Internally Forwarded",
];
