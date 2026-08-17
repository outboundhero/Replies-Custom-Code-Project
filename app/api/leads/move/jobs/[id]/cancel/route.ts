/**
 * POST /api/leads/move/jobs/[id]/cancel
 *
 * Cancels a Lead Mover job. The runner sees the flip next loop iteration and
 * stops leasing tasks; already-moved leads stay (copy-only, idempotent). Admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { cancelJob } from "@/lib/leads/move-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await params;
  const ok = await cancelJob(id);
  return NextResponse.json({ ok });
}
