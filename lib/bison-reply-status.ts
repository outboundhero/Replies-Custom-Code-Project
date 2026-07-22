/**
 * Mirror a lead's marked status back to the originating Bison instance.
 *
 * When a reply is marked with one of these `lead_category` values, we push the
 * matching status to the Bison workspace the reply came from:
 *   - Interested / Meeting-Ready Lead / Follow Up  → mark-as-interested
 *   - Do Not Contact                               → unsubscribe
 *
 * Used from two entry points, both keyed off the reply's `bison_instance` +
 * Bison `reply_id`:
 *   1. the Reply Router inbox (app/api/inbox/mutate — update-category), and
 *   2. Airtable automations (app/api/bison/mark-status), for marks made in
 *      Airtable by the partners.
 *
 * Both Bison endpoints are idempotent, so a repeated mark is a safe no-op.
 */
import { markReplyInterested, unsubscribeReplyLead } from "@/lib/outboundhero-api";
import { logActivity, logError } from "@/lib/errors";

/** `lead_category` values that map to Bison "interested". */
export const BISON_INTERESTED_CATEGORIES = ["Interested", "Meeting-Ready Lead", "Follow Up"] as const;
/** `lead_category` values that map to Bison "unsubscribe". */
export const BISON_UNSUBSCRIBE_CATEGORIES = ["Do Not Contact"] as const;

export type BisonReplyAction = "interested" | "unsubscribe";

/** Returns the Bison action for a lead_category, or null if it isn't synced. */
export function bisonActionForCategory(category: string | null | undefined): BisonReplyAction | null {
  if (!category) return null;
  const c = category.trim().toLowerCase();
  if (BISON_INTERESTED_CATEGORIES.some((x) => x.toLowerCase() === c)) return "interested";
  if (BISON_UNSUBSCRIBE_CATEGORIES.some((x) => x.toLowerCase() === c)) return "unsubscribe";
  return null;
}

export interface BisonSyncResult {
  ok: boolean;
  action: BisonReplyAction | null;
  skipped?: boolean; // category isn't one we sync
  error?: string;
}

/**
 * Apply the Bison status for `category` to `replyId` on `instance`.
 * Never throws — returns a result the caller can surface. Non-synced
 * categories return { ok:true, skipped:true } and make no API call.
 */
export async function syncReplyStatusToBison(params: {
  instance: string;
  replyId: number | null | undefined;
  category: string;
  source: string;            // audit label, e.g. "inbox" | "airtable"
  clientTag?: string | null;
}): Promise<BisonSyncResult> {
  const action = bisonActionForCategory(params.category);
  if (!action) return { ok: true, action: null, skipped: true };

  const replyId = Number(params.replyId);
  if (!Number.isFinite(replyId) || replyId <= 0) {
    return { ok: false, action, error: "missing/invalid reply_id" };
  }

  try {
    const res =
      action === "interested"
        ? await markReplyInterested(params.instance, replyId)
        : await unsubscribeReplyLead(params.instance, replyId);

    if (res.ok) {
      await logActivity(params.source, `bison-${action}`, {
        client_tag: params.clientTag || undefined,
        details: { reply_id: replyId, category: params.category, bison_instance: params.instance },
      });
      return { ok: true, action };
    }
    await logError(params.source, `bison-${action}`, res.error || "unknown", {
      reply_id: replyId, category: params.category, bison_instance: params.instance,
    });
    return { ok: false, action, error: res.error };
  } catch (e) {
    await logError(params.source, `bison-${action}`, (e as Error).message, {
      reply_id: replyId, category: params.category, bison_instance: params.instance,
    });
    return { ok: false, action, error: (e as Error).message };
  }
}
