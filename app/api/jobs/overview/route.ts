/**
 * GET /api/jobs/overview
 *
 * The Jobs page's other long-running work besides lead moves (those have their own
 * /api/leads/move/jobs/status): client resets, nurture queue removals, onboarding
 * automation runs and the campaign refresh, last 30 days (lib/jobs/overview.ts).
 * Read-only; the actions use each feature's own API. Admin.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { jobsOverview } from "@/lib/jobs/overview";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    return NextResponse.json(await jobsOverview());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
