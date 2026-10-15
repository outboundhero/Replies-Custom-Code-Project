/**
 * GET /api/clients/[tag]/campaigns — the client's campaigns in Email Bison (read-only),
 * in its group's two instances (all four when it has no group), with each
 * instance's sending schedule as its main Google + Custom campaign has it.
 * Loaded after the client page, so the page itself stays fast.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { withCache } from "@/lib/server-cache";
import { listCampaigns, getCampaignSchedule } from "@/lib/outboundhero-api";
import { getClientInstances } from "@/lib/nurture/group-routing";
import { BISON_INSTANCES, getInstanceLabel, type BisonInstanceKey } from "@/lib/bison-instances-shared";
import { normClientTag } from "@/lib/onboarding/copy-model";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ tag: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((session.allowedClientTags && session.allowedClientTags.length) || (session.role !== "admin" && session.role !== "inbox_manager")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const raw = (await params).tag;
  let tag: string | null;
  try { tag = normClientTag(decodeURIComponent(raw)); } catch { tag = null; }
  if (!tag) return NextResponse.json({ error: "Bad client tag" }, { status: 400 });
  try {
    const data = await withCache(`profile:campaigns:${tag}`, 60_000, async () => {
      const g = await getClientInstances(tag);
      const instances: BisonInstanceKey[] = g ? [g.b2b, g.b2c] : BISON_INSTANCES.map((i) => i.key);
      return Promise.all(instances.map(async (key) => {
        try {
          const all = await listCampaigns(key, { search: tag, strict: true });
          const mine = all
            .filter((c) => c.name.trim().toUpperCase().startsWith(`${tag}:`))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => ({ id: c.id, name: c.name, status: c.status, leads: c.total_leads ?? null, sent: c.emails_sent ?? null }));
          const main = mine.find((c) => /: Google \+ Custom \(/.test(c.name)) ?? mine.find((c) => !/\[Nurture/.test(c.name));
          const sc = main ? await getCampaignSchedule(key, main.id).catch(() => null) : null;
          const schedule = sc && sc.timezone ? { timezone: String(sc.timezone), start: String(sc.start_time ?? "").slice(0, 5), end: String(sc.end_time ?? "").slice(0, 5) } : null;
          return { key, label: getInstanceLabel(key), campaigns: mine, schedule, error: null as string | null };
        } catch (e) {
          return { key, label: getInstanceLabel(key), campaigns: [], schedule: null, error: (e as Error).message };
        }
      }));
    });
    return NextResponse.json({ ok: true, tag, instances: data });
  } catch (e) {
    console.error("[api/clients/campaigns]", e);
    return NextResponse.json({ error: "Couldn't read Email Bison." }, { status: 500 });
  }
}
