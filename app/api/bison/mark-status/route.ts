/**
 * POST /api/bison/mark-status
 *
 * Called by an Airtable automation when a lead's "Lead Category" is set to a
 * synced status, so a mark made in Airtable mirrors to the originating Bison
 * workspace:
 *   Interested / Meeting-Ready Lead / Follow Up → mark-as-interested
 *   Do Not Contact                              → unsubscribe
 *
 * Body: { replyId: number, instance?: string, category: string }
 *   - replyId  = the Airtable record's "Reply ID"
 *   - instance = the record's "Bison Instance" (optional; if missing/invalid we
 *                resolve it from Supabase by reply_id)
 *   - category = the record's "Lead Category"
 *
 * Auth: shared secret in the `x-webhook-secret` header (or ?secret=), matched
 * against AIRTABLE_SYNC_SECRET (falls back to CRON_SECRET so it works out of the
 * box). Bison tokens never leave the server — Airtable only holds this secret.
 */
import { NextRequest, NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { isValidInstance, coerceInstance } from "@/lib/bison-instances";
import { syncReplyStatusToBison, bisonActionForCategory } from "@/lib/bison-reply-status";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const provided =
    req.headers.get("x-webhook-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const expected = process.env.AIRTABLE_SYNC_SECRET || process.env.CRON_SECRET;
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { replyId?: number | string; instance?: string; category?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const replyId = Number(body.replyId);
  const category = String(body.category || "").trim();
  if (!Number.isFinite(replyId) || replyId <= 0) {
    return NextResponse.json({ error: "replyId is required" }, { status: 400 });
  }
  if (!category) {
    return NextResponse.json({ error: "category is required" }, { status: 400 });
  }

  // Non-synced categories are a fast success no-op (the Airtable trigger may be
  // broader than our four statuses).
  if (!bisonActionForCategory(category)) {
    return NextResponse.json({ ok: true, skipped: true, reason: `category "${category}" is not synced to Bison` });
  }

  // Prefer the instance Airtable sent; otherwise resolve it from the reply row.
  let instance = String(body.instance || "");
  if (!isValidInstance(instance)) {
    const { data } = await supabase
      .from("replies")
      .select("bison_instance")
      .eq("reply_id", replyId)
      .limit(1);
    instance = coerceInstance((data?.[0]?.bison_instance as string | undefined) ?? undefined);
  }

  const result = await syncReplyStatusToBison({ instance, replyId, category, source: "airtable", clientTag: null });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
