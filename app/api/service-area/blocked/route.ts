/**
 * GET /api/service-area/blocked?tag=JPC[&since=2026-10-21T00:00:00Z][&after=<email>]
 *
 * For the lead database (read-only): the leads a client has taken out for a
 * service-area change, so its push worker never sends them back into that
 * client's campaigns, plus the places removed (to stop targeting them).
 *   blocked  — { email, blocked: true|false (false = let back in), changed_at, change_id }
 *              (all current ones without `since`; with `since`, what changed after it),
 *              5,000 per page in email order — while `next_after` is set, ask again with
 *              `after=<next_after>` (same `since`)
 *   next_since — use as `since` next time: when this answer was read, less a minute
 *              (so a row written during the read is never missed; re-reading one is harmless)
 *   removed_places — the places of approved / finished changes, with their removal day
 *
 * Auth: `Authorization: Bearer <SERVICE_AREA_API_KEY>` or `x-api-key` — its own key.
 * Off until SERVICE_AREA_API_KEY is set.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { suppressionsSince } from "@/lib/service-area-changes/suppression";
import { listChanges } from "@/lib/service-area-changes/store";
import { normClientTag } from "@/lib/onboarding/copy-model";

export const dynamic = "force-dynamic";

const PAGE = 5000;

function authorized(req: NextRequest): boolean {
  const key = process.env.SERVICE_AREA_API_KEY?.trim();
  if (!key) return false;
  const given = (req.headers.get("x-api-key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")).trim();
  const a = Buffer.from(given), b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const tag = normClientTag(req.nextUrl.searchParams.get("tag"));
  if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });
  const sinceRaw = req.nextUrl.searchParams.get("since");
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw).toISOString() : null;
  const afterEmail = String(req.nextUrl.searchParams.get("after") || "").trim().toLowerCase();
  const readAt = Date.now();
  try {
    const page = await suppressionsSince(tag, since, afterEmail, PAGE);
    const blocked = page.filter((b) => since || b.blocked);
    const removed_places = (await listChanges(tag, 1000))
      .filter((c) => ["approved", "topup", "removing", "verifying", "done", "partial"].includes(c.status))
      .flatMap((c) => c.places.map((p) => ({ type: p.type, label: p.label, state: p.state ?? null, city: p.type === "city" ? p.city ?? null : null, zip: p.zip ?? null, removal_date: c.removalDate, change_id: c.id })));
    return NextResponse.json({
      ok: true, tag, generated_at: new Date(readAt).toISOString(), next_since: new Date(readAt - 60_000).toISOString(),
      blocked, next_after: page.length === PAGE ? page[page.length - 1].email : null, removed_places,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
