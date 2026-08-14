/**
 * Push a DM4PM subsequence reply back into the inbox "Open Responses" queue
 * (§11 prospect reply, §18 canceled meeting). Mirrors the inbox update-category
 * restore: set lead_category = "Open Response", restart the speed-to-lead clock
 * (best-effort — those columns may be pre-migration), and broadcast so the
 * inbox refreshes in realtime.
 */
import supabase from "@/lib/supabase";
import { broadcastReplyChange } from "@/lib/realtime-broadcast";

export async function returnReplyToOpenResponse(replyRowId: number): Promise<void> {
  const nowIso = new Date().toISOString();
  // Read the signal fields the realtime broadcast needs.
  let clientTag: string | null = null, aiCat: string | null = null, noise = false;
  try {
    const { data } = await supabase
      .from("replies")
      .select("client_tag, ai_categorized_lead_category, inbox_is_noise")
      .eq("id", replyRowId)
      .single();
    const d = data as { client_tag?: string | null; ai_categorized_lead_category?: string | null; inbox_is_noise?: boolean | null } | null;
    clientTag = d?.client_tag ?? null;
    aiCat = d?.ai_categorized_lead_category ?? null;
    noise = !!d?.inbox_is_noise;
  } catch { /* best-effort */ }

  await supabase
    .from("replies")
    .update({ lead_category: "Open Response", updated_at: nowIso })
    .eq("id", replyRowId);

  // Speed-to-lead timing restart — separate update so a missing column (pre
  // migration) can't roll back the category change above.
  try {
    await supabase
      .from("replies")
      .update({ open_response_at: nowIso, categorized_at: null })
      .eq("id", replyRowId);
  } catch { /* columns may not exist yet */ }

  await broadcastReplyChange({
    client_tag: clientTag,
    lead_category: "Open Response",
    ai_categorized_lead_category: aiCat,
    inbox_is_noise: noise,
  }).catch(() => {});
}
