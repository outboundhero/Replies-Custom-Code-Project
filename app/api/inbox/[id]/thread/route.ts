/**
 * GET /api/inbox/{id}/thread
 *
 * The lead's full email history for the inbox history panel:
 *  - `thread`: campaign cold email + follow-ups + all replies (merged from Bison
 *    via buildConversationThread; works for tracked + untracked).
 *  - `sends`: our own ReplyRouter send attempts (reply_sends), with status/error
 *    so failures are visible + retryable.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { coerceInstance } from "@/lib/bison-instances";
import { buildConversationThread } from "@/lib/inbox/conversation-thread";

export const maxDuration = 30;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await params;
    const { data: r, error } = await supabase
      .from("replies")
      .select("client_tag, reply_id, lead_id, campaign_id, bison_instance, lead_email")
      .eq("id", Number(id))
      .single();
    if (error || !r) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const allowed = session?.allowedClientTags ?? null;
    if (allowed?.length && (!r.client_tag || !allowed.includes(r.client_tag))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [thread, sends] = await Promise.all([
      r.reply_id
        ? buildConversationThread({
            instance: coerceInstance(r.bison_instance),
            replyId: Number(r.reply_id),
            leadId: r.lead_id ? Number(r.lead_id) : null,
            campaignId: r.campaign_id ? Number(r.campaign_id) : null,
            leadEmail: String(r.lead_email || ""),
          }).catch(() => [])
        : Promise.resolve([]),
      supabase
        .from("reply_sends")
        .select("id, status, error, message, created_at")
        .eq("reply_row_id", Number(id))
        .order("created_at", { ascending: false })
        .then((res) => res.data || [])
        .then((rows) => rows, () => []),
    ]);

    return NextResponse.json({ thread, sends });
  } catch (e) {
    console.error("[api/inbox/[id]/thread] failed:", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
