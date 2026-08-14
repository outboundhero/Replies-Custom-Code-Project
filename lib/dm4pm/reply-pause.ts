/**
 * Ingest hook (§11/§13): when a DM4PM prospect replies, pause their subsequence.
 *
 * Called from tracked/untracked ingest AFTER the reply upsert. Detects
 * enrollment by the stable lead EMAIL (repeat replies spawn new reply rows), and
 * when live: pauses (preserving step), resets the continuation timer, returns
 * the reply to Open Responses, and stamps the subsequence badge onto the reply
 * row that just came in. Best-effort — never throws, so ingest can't break.
 *
 * NOTE: this only pauses. The 5-business-day continuation timer (§12/§13) does
 * NOT start here — it starts only when our team responds (send-reply).
 */
import * as store from "@/lib/dm4pm/subsequence-store";
import { returnReplyToOpenResponse } from "@/lib/dm4pm/reply-sync";
import { isSubsequenceTag } from "@/lib/subsequence/config";

export async function pauseSubsequenceOnReply(params: {
  replyRowId: number | null;
  leadEmail: string | null;
  clientTag: string | null;
}): Promise<void> {
  try {
    if (!isSubsequenceTag(params.clientTag)) return;
    const email = (params.leadEmail || "").trim();
    if (!email) return;

    const sub = await store.getByEmail(email);
    if (!sub || !["active", "paused", "snoozed"].includes(sub.status)) return;

    await store.pauseForProspectReply(sub.id);

    // Surface THIS reply (which may be a new row from a repeat reply) in Open
    // Responses, with the subsequence badge on it.
    const replyRowId = params.replyRowId ?? sub.reply_row_id;
    await store.setReplyBadge(replyRowId, "paused", sub.step);
    await returnReplyToOpenResponse(replyRowId);
  } catch {
    /* ingest must never break on this hook */
  }
}
