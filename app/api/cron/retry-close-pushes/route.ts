/**
 * GET /api/cron/retry-close-pushes — RETIRED. OH → Close.com CRM is no longer a
 * destination (OH leads now flow to the shared Clay table; see lib/oh-webhook.ts),
 * so this retry loop is a no-op. Kept as an inert endpoint (and unscheduled in
 * vercel.json) so any stale invocation can't resurrect a Close push for leftover
 * failure rows.
 */
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ ok: true, retired: true, processed: 0 });
}
