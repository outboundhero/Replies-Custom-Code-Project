/**
 * POST /api/leads/move/jobs/[id]/retry
 *
 * "Retry errored": resets a job's FAILED tasks back to pending (from their saved
 * cursor), queues every lead that errored to be sent again, and re-kicks the
 * runner. Admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { retryJob } from "@/lib/leads/move-jobs";
import { triggerRunner } from "@/lib/leads/run-move-job";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await params;
  const r = await retryJob(id);
  if (r.tasks + r.leads > 0) triggerRunner(id);
  return NextResponse.json({ ok: true, ...r });
}
