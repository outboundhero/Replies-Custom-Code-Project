/**
 * Service-area alerts — places added to or taken out of a client's service area
 * on the Onboarding Form (raised by the sheet sync, every 6 hours).
 *
 * GET  [?count=1] → the open alerts, newest first (or just how many, for the sidebar)
 * POST { action: "dismiss", id, tag, toVersion } → mark one as looked at (nothing to
 *      remove) — as it was seen: if a newer edit changed it since, it stays open (409)
 *
 * Team only (admins and inbox managers not limited to certain clients).
 */
import { NextRequest, NextResponse } from "next/server";
import { teamSession } from "@/lib/service-area-changes/access";
import { ALERT_NS, handleAlert, openAlertCount, openAlerts } from "@/lib/service-area-changes/text-versions";
import { nsVersion, withCache } from "@/lib/server-cache";
import { normClientTag } from "@/lib/onboarding/copy-model";
import { logActivity } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const t = await teamSession();
  if (!t.ok) return t.res;
  try {
    if (req.nextUrl.searchParams.get("count")) {
      const count = await withCache(`service-area:alert-count:v${nsVersion(ALERT_NS)}`, 60_000, openAlertCount);
      return NextResponse.json({ ok: true, count });
    }
    return NextResponse.json({ ok: true, alerts: await openAlerts() });
  } catch (e) {
    console.error("[api/service-area/alerts]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const t = await teamSession();
  if (!t.ok) return t.res;
  const body = await req.json().catch(() => ({}));
  const id = Number(body?.id);
  let tag: string | null;
  try { tag = normClientTag(String(body?.tag ?? "")); } catch { tag = null; }
  const toVersion = Number(body?.toVersion);
  if (body?.action !== "dismiss" || !Number.isInteger(id) || id <= 0 || !tag || !Number.isInteger(toVersion)) return NextResponse.json({ error: "action dismiss, id, tag and toVersion required" }, { status: 400 });
  try {
    if (!(await handleAlert(id, tag, toVersion, "dismissed", t.email))) return NextResponse.json({ error: "It changed or was already handled — reload to see the latest." }, { status: 409 });
    await logActivity("service-area", "alert-dismissed", { client_tag: tag, details: { alert_id: id, by: t.email } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
