/**
 * GET /api/nurture/queue?tag=X&search=&email=&web=&source=&tld=&overlap=&limit=&offset=
 * One page of a client's nurture queue (one row per contact, most-due first)
 * + the total matching count — paged + filtered in the database
 * (nurture_queue_page), so it works on queues of any size.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { activeClientTags } from "@/lib/nurture/overview";
import { parseQueueFilters, toRpcArgs, toQueueContact } from "@/lib/nurture/queue-filters";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  const tag = (sp.get("tag") || "").trim();
  if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });
  const limit = Math.min(200, Math.max(1, Number(sp.get("limit")) || 50));
  const offset = Math.max(0, Number(sp.get("offset")) || 0);
  try {
    const { churned } = await activeClientTags();
    const { data, error } = await supabase.rpc("nurture_queue_page", {
      p_tag: tag, ...toRpcArgs(parseQueueFilters(sp)), p_ignore_tags: churned, p_limit: limit, p_offset: offset,
    });
    if (error) throw new Error(error.message);
    const rows = (data || []) as Array<Record<string, unknown>>;
    return NextResponse.json({
      total: rows.length ? Number(rows[0].total_count) : 0,
      limit, offset,
      contacts: rows.map(toQueueContact),
    });
  } catch (e) {
    console.error("[api/nurture/queue]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
