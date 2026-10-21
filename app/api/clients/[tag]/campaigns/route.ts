/**
 * GET /api/clients/[tag]/campaigns — the client's campaigns in Email Bison (read-only),
 * with their ids, in all four instances (B2B #1 / B2C #1 / B2B #2 / B2C #2 — a
 * client's campaigns can sit outside its current group, e.g. after a move), its
 * current group's first. Each current instance carries its sending schedule as
 * its main Google + Custom campaign has it. Loaded after the client page, so the
 * page itself stays fast.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { withCache } from "@/lib/server-cache";
import { listCampaigns, getCampaignSchedule } from "@/lib/outboundhero-api";
import { getClientInstances } from "@/lib/nurture/group-routing";
import { BISON_INSTANCES, getInstanceLabel, type BisonInstanceKey } from "@/lib/bison-instances-shared";
import { normClientTag } from "@/lib/onboarding/copy-model";

/** Each instance's place in the groups (Group 1 = OutboundHero + Cleaning Outbound, Group 2 = Facility Reach + Outbound Clean). */
const ROLE: Record<BisonInstanceKey, string> = {
  outboundhero: "B2B #1", cleaningoutbound: "B2C #1", facilityreach: "B2B #2", outboundclean: "B2C #2",
};
const ORDER: BisonInstanceKey[] = ["outboundhero", "cleaningoutbound", "facilityreach", "outboundclean"];

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
    const data = await withCache(`profile:campaigns:v2:${tag}`, 60_000, async () => {
      const g = await getClientInstances(tag);
      const current = new Set<BisonInstanceKey>(g ? [g.b2b, g.b2c] : []);
      // The current group's two first, then the other two.
      const instances = [...ORDER.filter((k) => current.has(k)), ...ORDER.filter((k) => !current.has(k) && BISON_INSTANCES.some((i) => i.key === k))];
      return Promise.all(instances.map(async (key) => {
        // current: in the client's group now — null when its group isn't known.
        const base = { key, label: getInstanceLabel(key), role: ROLE[key], current: g ? current.has(key) : null };
        try {
          const all = await listCampaigns(key, { search: tag, strict: true });
          const mine = all
            .filter((c) => c.name.trim().toUpperCase().startsWith(`${tag}:`))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => ({ id: c.id, uuid: c.uuid ?? null, name: c.name, status: c.status, leads: c.total_leads ?? null, sent: c.emails_sent ?? null }));
          // The sending schedule only for the instances the client sends from now (or all, with no group).
          const main = (current.has(key) || !g) ? (mine.find((c) => /: Google \+ Custom \(/.test(c.name)) ?? mine.find((c) => !/\[Nurture/.test(c.name))) : undefined;
          const sc = main ? await getCampaignSchedule(key, main.id).catch(() => null) : null;
          const schedule = sc && sc.timezone ? { timezone: String(sc.timezone), start: String(sc.start_time ?? "").slice(0, 5), end: String(sc.end_time ?? "").slice(0, 5) } : null;
          return { ...base, campaigns: mine, schedule, error: null as string | null };
        } catch (e) {
          return { ...base, campaigns: [], schedule: null, error: (e as Error).message };
        }
      }));
    });
    return NextResponse.json({ ok: true, tag, instances: data });
  } catch (e) {
    console.error("[api/clients/campaigns]", e);
    return NextResponse.json({ error: "Couldn't read Email Bison." }, { status: 500 });
  }
}
