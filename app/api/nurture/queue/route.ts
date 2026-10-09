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
import { acquireHeavyLease, releaseHeavyLease, leaseHolder } from "@/lib/nurture/heavy-lease";

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
    const filters = parseQueueFilters(sp);
    // "Overlapping only" checks every contact against every other queue (the
    // heavy computation that otherwise runs overnight) — it takes the lease.
    const holder = filters.overlapOnly ? leaseHolder("queue-overlap") : null;
    if (holder && !(await acquireHeavyLease(holder, 90_000))) {
      return NextResponse.json({ error: "Another heavy queue job is running — try “Overlapping only” again in a minute." }, { status: 429 });
    }
    const page = async (lim: number, off: number) => {
      const { data, error } = await supabase.rpc("nurture_queue_page", {
        p_tag: tag, ...toRpcArgs(filters), p_ignore_tags: churned, p_limit: lim, p_offset: off,
      });
      if (error) throw new Error(error.message);
      return (data || []) as Array<Record<string, unknown>>;
    };
    let rows: Array<Record<string, unknown>>, total: number;
    try {
      rows = await page(limit, offset);
      total = rows.length ? Number(rows[0].total_count) : 0;
      // Past the last page (e.g. after removals) the page is empty and carries
      // no total — ask for it, so the client can step back to the real last page.
      if (!rows.length && offset > 0) {
        const first = await page(1, 0);
        total = first.length ? Number(first[0].total_count) : 0;
      }
    } finally {
      if (holder) await releaseHeavyLease(holder).catch(() => {});
    }
    return NextResponse.json({ total, limit, offset, contacts: rows.map(toQueueContact) });
  } catch (e) {
    console.error("[api/nurture/queue]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
