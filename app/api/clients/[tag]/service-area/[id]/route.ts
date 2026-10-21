/**
 * GET /api/clients/[tag]/service-area/[id] — one change for its review page:
 * the change, its counts, the scan's progress, any part of the scan that
 * couldn't be read, and whether it can be approved yet (and why not).
 */
import { NextRequest, NextResponse } from "next/server";
import { teamAccess } from "@/lib/service-area-changes/access";
import { changeSummary, counts, failedTasks, getChange, taskProgress } from "@/lib/service-area-changes/store";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ tag: string; id: string }> }) {
  const p = await params;
  const a = await teamAccess(p.tag);
  if (!a.ok) return a.res;
  const id = Number(p.id);
  try {
    const change = Number.isInteger(id) ? await getChange(id) : null;
    if (!change || change.clientTag !== a.tag) return NextResponse.json({ error: "Change not found" }, { status: 404 });
    const [c, progress, failed] = await Promise.all([counts(id), taskProgress(id), failedTasks(id)]);
    const blockers: string[] = [];
    if (change.status === "scanning") blockers.push(change.quickDoneAt ? "Still reading every lead in the background — approval opens when that finishes." : "Still looking for leads.");
    if (failed.length) blockers.push(`${failed.length} part${failed.length === 1 ? "" : "s"} of the check couldn't be read — retry ${failed.length === 1 ? "it" : "them"} first.`);
    if (change.status === "review" && c.ticked === 0) blockers.push("Nothing is ticked to remove.");
    return NextResponse.json({
      ok: true,
      change: { ...changeSummary(change), campaignList: change.campaigns },
      counts: c, progress, failed,
      canApprove: change.status === "review" && blockers.length === 0,
      blockers,
      now: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[api/clients/service-area/id]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
