/**
 * Auto-map nurture campaigns for active clients (DRAFT + gap-fill only).
 *
 * GET  /api/nurture/auto-map[?needsMap=1]
 *   → { clients: [{ tag, group, b2b, b2c, mappedSlots, expectedSlots }] }
 *   The active mappable set (client_status Active ∩ has group ∩ not churned).
 *   With ?needsMap=1, only clients that still have an unmapped cell.
 *
 * POST /api/nurture/auto-map  { clientTag, dryRun? }
 *   → AutoMapReport for that ONE client (added / skippedAlreadyMapped /
 *     noCandidate / ambiguous). The UI loops this client-by-client for live
 *     progress. dryRun computes without writing.
 *
 * Never stamps nurture_map_confirmed_at and never attaches inboxes / activates —
 * sending stays gated until the operator confirms each client's map.
 *
 * Auth: admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getClientInstances } from "@/lib/nurture/group-routing";
import {
  getActiveMappableClients,
  annotateMappedSlots,
  autoMapClient,
} from "@/lib/nurture/auto-map";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const needsMap = req.nextUrl.searchParams.get("needsMap") === "1";
  const active = await getActiveMappableClients();
  const annotated = await annotateMappedSlots(active);
  const clients = needsMap
    ? annotated.filter((c) => (c.mappedSlots ?? 0) < (c.expectedSlots ?? 0))
    : annotated;
  return NextResponse.json({ clients, total: clients.length });
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { clientTag?: string; dryRun?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const clientTag = (body.clientTag || "").trim().toUpperCase();
  if (!clientTag) return NextResponse.json({ error: "clientTag required" }, { status: 400 });

  const instances = await getClientInstances(clientTag);
  const report = await autoMapClient(
    clientTag,
    instances ? { b2b: instances.b2b, b2c: instances.b2c } : null,
    { dryRun: !!body.dryRun },
  );

  return NextResponse.json({ ok: true, dryRun: !!body.dryRun, report });
}
