/**
 * POST /api/leads/move/jobs/[id]/dismiss
 *
 * Hides a finished move from the lists, for everyone. A queued or running move
 * can't be hidden. Admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getSession } from "@/lib/auth";
import { dismissJob } from "@/lib/leads/move-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const session = await getSession();
  const { id } = await params;
  const ok = await dismissJob(id, session?.email ?? null);
  if (!ok) return NextResponse.json({ error: "Only a finished move can be dismissed." }, { status: 409 });
  return NextResponse.json({ ok });
}
