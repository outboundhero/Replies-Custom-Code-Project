/**
 * POST /api/leads/move/jobs/[id]/retry
 *
 * Resets a job's FAILED tasks back to pending (from their saved cursor) and
 * re-kicks the runner. Admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { retryFailedTasks } from "@/lib/leads/move-jobs";
import { triggerRunner } from "@/lib/leads/run-move-job";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await params;
  const reset = await retryFailedTasks(id);
  triggerRunner(id);
  return NextResponse.json({ ok: true, reset });
}
