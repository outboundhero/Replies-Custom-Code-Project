/**
 * GET /api/leads/move/jobs/status
 *
 * Fast, Turso-only status of Lead Mover jobs — polled by the /migrate page and
 * the global banner. `?scope=active` → only pending/running (banner); default →
 * active + recently-finished; `?jobId=` → one job. Any signed-in user can read.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getStatusJobs } from "@/lib/leads/move-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const scope = req.nextUrl.searchParams.get("scope") === "active" ? "active" : "all";
  const jobId = req.nextUrl.searchParams.get("jobId") || undefined;
  try {
    const jobs = await getStatusJobs({ scope, jobId });
    return NextResponse.json({ jobs });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
