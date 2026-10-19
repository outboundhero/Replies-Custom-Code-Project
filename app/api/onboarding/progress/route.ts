/**
 * GET /api/onboarding/progress?taskId=… — what LeadSync is doing right now for
 * a step that works through it, step by step, so the Run screen can show it
 * live (tagging, redirect, each campaign, the sheet, the whitelist queue, the
 * checks). Only the domains step has it today. Admin-only, like the run itself.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getTask } from "@/lib/onboarding/store";
import { onboardingBatchProgress } from "@/lib/leadsync";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const task = await getTask(String(req.nextUrl.searchParams.get("taskId") || ""));
  if (!task) return NextResponse.json({ error: "Task not found." }, { status: 404 });
  if (task.automation !== "allocate_domains") return NextResponse.json({ progress: null });
  return NextResponse.json({ progress: await onboardingBatchProgress(task.client_tag.toUpperCase()) });
}
