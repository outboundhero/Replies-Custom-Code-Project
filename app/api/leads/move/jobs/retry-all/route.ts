/**
 * POST /api/leads/move/jobs/retry-all
 *
 * "Retry all errors": every finished move in the history that has failed
 * campaigns or errored leads gets them queued again; the runner takes the jobs
 * one at a time. Admin.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { retryAllJobs } from "@/lib/leads/move-jobs";
import { triggerRunner } from "@/lib/leads/run-move-job";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  const denied = await requireAdmin();
  if (denied) return denied;
  const r = await retryAllJobs();
  if (r.jobs > 0) triggerRunner();
  return NextResponse.json({ ok: true, ...r });
}
