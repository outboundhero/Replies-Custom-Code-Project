/**
 * The Nurture pages' "Refresh campaigns" button (admins).
 *
 * GET  → when the campaigns were last refreshed (and by whom), and whether a refresh is running
 * POST → refresh them now from all 4 Email Bison instances — the same refresh that runs every
 *        10 minutes (lib/nurture/refresh-campaigns.ts). If one is already under way, says so.
 */
import { NextResponse } from "next/server";
import { requireAdmin, getSession } from "@/lib/auth";
import { refreshNurtureCampaigns, lastCampaignRefresh } from "@/lib/nurture/refresh-campaigns";
import { logActivity } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    return NextResponse.json({ ok: true, ...(await lastCampaignRefresh()) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST() {
  const denied = await requireAdmin();
  if (denied) return denied;
  const by = (await getSession())?.email ?? null;
  try {
    const r = await refreshNurtureCampaigns({ by, manual: true });
    if (r.busy) return NextResponse.json({ ok: true, busy: true });
    await logActivity("nurture", "campaigns-refreshed", { details: { by, cached: r.cached, mains: r.mains, ms: r.ms, failures: r.failures ?? [] } }).catch(() => {});
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
