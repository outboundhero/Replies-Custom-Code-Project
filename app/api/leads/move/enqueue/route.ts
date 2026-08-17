/**
 * POST /api/leads/move/enqueue
 *
 * Persists a Lead Mover run as a durable job (move_job + move_job_task) and kicks
 * the server-side runner. Replaces the browser-driven loop — once enqueued, the
 * server completes the whole move on its own regardless of the tab. Idempotent on
 * `runId` (double-submit returns the existing job). Admin-gated.
 *
 * Body (cross): { kind:"cross", from, to, toLabel?, serviceAreaFilter?, runId?,
 *   clients:[{ tag, dest:{google?,outlook?,segs?}, sourceCampaigns:[{id,name,totalLeads}] }] }
 * Body (same):  { kind:"same", clientTag, b2bInstance, b2cInstance, serviceAreaFilter?, runId?,
 *   jobs:[{ sourceInstance, sourceCampaignId, sourceCampaignName, totalLeads, dest:{b2b:{…},b2c:{…}} }],
 *   skipped?:[{ sourceCampaignName, reason }] }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getSession } from "@/lib/auth";
import { getInstanceLane } from "@/lib/bison-instances-shared";
import { createJob, type NewTask } from "@/lib/leads/move-jobs";
import { triggerRunner } from "@/lib/leads/run-move-job";
import type { Esp } from "@/lib/nurture/esp";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ESPS: Esp[] = ["google", "outlook", "segs"];
const espMap = (o: unknown): Partial<Record<Esp, number>> => {
  const out: Partial<Record<Esp, number>> = {};
  for (const e of ESPS) { const v = Number((o as Record<string, unknown> | undefined)?.[e]); if (v) out[e] = v; }
  return out;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const session = await getSession();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const runId = String(body.runId || "").trim() || crypto.randomUUID();
  const serviceAreaFilter = body.serviceAreaFilter !== false; // default ON
  const createdBy = session?.email || null;

  if (body.kind === "cross") {
    const from = String(body.from || "").trim();
    const to = String(body.to || "").trim();
    if (!from || !to) return NextResponse.json({ error: "from and to are required" }, { status: 400 });
    const targetLane = getInstanceLane(to);

    const tasks: NewTask[] = [];
    for (const c of body.clients || []) {
      const tag = String(c.tag || "").trim().toUpperCase();
      if (!tag) continue;
      const dest = espMap(c.dest);
      const hasDest = Object.keys(dest).length > 0;
      for (const sc of c.sourceCampaigns || []) {
        const id = Number(sc.id);
        if (!id) continue;
        tasks.push({
          clientTag: tag, sourceInstance: from, sourceCampaignId: id, sourceCampaignName: String(sc.name || ""),
          targetInstance: to, dest, serviceAreaFilter, totalLeads: Number(sc.totalLeads) || 0,
          status: hasDest ? "pending" : "skipped", error: hasDest ? null : "no destination campaign for this client",
        });
      }
    }
    if (!tasks.length) return NextResponse.json({ error: "no source campaigns to move" }, { status: 400 });

    const jobId = await createJob({
      runId, kind: "cross", createdBy, targetInstance: to, targetLabel: String(body.toLabel || to), targetLane, serviceAreaFilter, tasks,
    });
    triggerRunner(jobId);
    return NextResponse.json({ ok: true, jobId, runId });
  }

  if (body.kind === "same") {
    const clientTag = String(body.clientTag || "").trim().toUpperCase();
    const b2bInstance = String(body.b2bInstance || "").trim();
    const b2cInstance = String(body.b2cInstance || "").trim();
    if (!clientTag || !b2bInstance || !b2cInstance) return NextResponse.json({ error: "clientTag, b2bInstance, b2cInstance required" }, { status: 400 });

    const tasks: NewTask[] = [];
    for (const j of body.jobs || []) {
      const id = Number(j.sourceCampaignId);
      if (!id) continue;
      const dest = { b2b: espMap(j.dest?.b2b), b2c: espMap(j.dest?.b2c) };
      const hasDest = ESPS.some((e) => dest.b2b[e] || dest.b2c[e]);
      tasks.push({
        clientTag, sourceInstance: String(j.sourceInstance || "").trim(), sourceCampaignId: id, sourceCampaignName: String(j.sourceCampaignName || ""),
        b2bInstance, b2cInstance, dest, serviceAreaFilter, totalLeads: Number(j.totalLeads) || 0,
        status: hasDest ? "pending" : "skipped", error: hasDest ? null : "no destination for this (lane, ESP)",
      });
    }
    for (const s of body.skipped || []) {
      tasks.push({
        clientTag, sourceInstance: "", sourceCampaignId: 0, sourceCampaignName: String(s.sourceCampaignName || ""),
        b2bInstance, b2cInstance, dest: { b2b: {}, b2c: {} }, serviceAreaFilter, totalLeads: 0,
        status: "skipped", error: String(s.reason || "skipped"),
      });
    }
    if (!tasks.length) return NextResponse.json({ error: "no source campaigns to move" }, { status: 400 });

    const jobId = await createJob({
      runId, kind: "same", createdBy, targetInstance: null, targetLabel: `${clientTag} — same instance`, targetLane: null, serviceAreaFilter, tasks,
    });
    triggerRunner(jobId);
    return NextResponse.json({ ok: true, jobId, runId });
  }

  return NextResponse.json({ error: "unknown kind (expected 'cross' or 'same')" }, { status: 400 });
}
