/**
 * GET /api/clients/[tag]/service-area/[id]/leads?tab=match|check|noloc|ticked&q=&after=<cursor>&size=200[&result=failed]
 * One page of a change's leads with where each one sits. Pages by position:
 * `after` is the `next` cursor of the page before.
 */
import { NextRequest, NextResponse } from "next/server";
import { teamAccess } from "@/lib/service-area-changes/access";
import { getChange, pageLeads, type Tab } from "@/lib/service-area-changes/store";

export const dynamic = "force-dynamic";

const TABS: Tab[] = ["match", "check", "noloc", "ticked"];

export async function GET(req: NextRequest, { params }: { params: Promise<{ tag: string; id: string }> }) {
  const p = await params;
  const a = await teamAccess(p.tag);
  if (!a.ok) return a.res;
  const id = Number(p.id);
  const sp = req.nextUrl.searchParams;
  const tab = (sp.get("tab") || "match") as Tab;
  if (!TABS.includes(tab)) return NextResponse.json({ error: "Unknown tab" }, { status: 400 });
  let after: [string, string, string] | null = null;
  try {
    const raw = sp.get("after");
    if (raw) { const v = JSON.parse(raw); if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "string")) after = v as [string, string, string]; }
  } catch { /* first page */ }
  const size = Math.min(500, Math.max(10, Math.floor(Number(sp.get("size")) || 200)));
  try {
    const change = Number.isInteger(id) ? await getChange(id) : null;
    if (!change || change.clientTag !== a.tag) return NextResponse.json({ error: "Change not found" }, { status: 404 });
    const r = await pageLeads(id, { tab, q: sp.get("q") || undefined, result: sp.get("result") || undefined }, after, size);
    return NextResponse.json({ ok: true, ...r, size });
  } catch (e) {
    console.error("[api/clients/service-area/leads]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
