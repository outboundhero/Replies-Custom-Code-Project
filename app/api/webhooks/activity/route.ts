/**
 * GET /api/webhooks/activity
 *   ?instance=<key>        (required — one Bison workspace)
 *   &cursor=<next_cursor>  (optional — from a previous page)
 *   &status=failed|all     (optional — default all)
 *   &type=<event_type>     (optional — Bison event type filter)
 *
 * Returns the last 3 days of webhook deliveries for that instance, flattened
 * from Bison's /api/events, newest first, with cursor pagination. Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { isValidInstance } from "@/lib/bison-instances";
import { fetchWebhookActivity } from "@/lib/bison-webhooks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const instance = sp.get("instance") || "";
  if (!isValidInstance(instance)) {
    return NextResponse.json({ error: `Unknown or missing instance: "${instance}"` }, { status: 400 });
  }

  const cursor = sp.get("cursor");
  const onlyFailed = sp.get("status") === "failed";
  const type = sp.get("type");

  try {
    const page = await fetchWebhookActivity(instance, { cursor, onlyFailed, type, sinceDays: 3 });
    return NextResponse.json(page);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
