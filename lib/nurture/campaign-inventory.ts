/**
 * Per-client campaign inventory for the nurture activation gate + schedule offset.
 *
 * A client tag maps to a b2b + b2c Bison instance (lib/nurture/group-routing.ts).
 * "Main" campaigns are the client's non-nurture campaigns (`TAG: <ESP> (…)`);
 * "Nurture" campaigns carry the `[Nurture]` marker (isCanonicalNurtureCampaign).
 *
 * `listCampaigns` returns only totals (no contacted count), so completion is
 * computed by fetching `getCampaignDetails` per main campaign.
 */
import {
  listCampaignsCached,
  getCampaignDetails,
  type OutboundCampaign,
} from "@/lib/outboundhero-api";
import { getClientInstances } from "@/lib/nurture/group-routing";
import { isCanonicalNurtureCampaign, detectCampaignEsp, type Esp } from "@/lib/nurture/esp";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";
import type { BisonInstanceKey } from "@/lib/bison-instances-shared";

export interface InstanceCampaign extends OutboundCampaign {
  instance: BisonInstanceKey;
}

/** The distinct instances a client spans (b2b + b2c, deduped). */
async function clientInstances(tag: string): Promise<BisonInstanceKey[]> {
  const inst = await getClientInstances(tag);
  if (!inst) return [];
  return [...new Set([inst.b2b, inst.b2c])];
}

/**
 * All MAIN (non-nurture) campaigns for a client tag across its instances.
 * A campaign is "main" when its name-tag matches AND it is not a `[Nurture]`.
 */
export async function listMainCampaigns(tag: string): Promise<InstanceCampaign[]> {
  const instances = await clientInstances(tag);
  const out: InstanceCampaign[] = [];
  for (const instance of instances) {
    const camps = await listCampaignsCached(instance, { search: `${tag}:` });
    for (const c of camps) {
      if (
        extractTagFromCampaignName(c.name).toLowerCase() === tag.toLowerCase() &&
        !isCanonicalNurtureCampaign(c.name)
      ) {
        out.push({ ...c, instance });
      }
    }
  }
  return out;
}

/** Campaign statuses that mean "currently sending" (must be paused to stop). */
export const ON_STATUSES = new Set(["active", "queued"]);
export function isOn(status: string | null | undefined): boolean {
  return ON_STATUSES.has(String(status ?? "").toLowerCase());
}

/**
 * All NURTURE campaigns for a client tag across its instances, ANY status
 * (active/queued/paused/draft/completed). Includes the `[Nurture N]` capacity
 * clones. No status filter — so the pause step never misses a live ("queued")
 * campaign, and callers classify with `isOn()`.
 */
export async function listNurtureCampaigns(
  tag: string,
): Promise<Array<InstanceCampaign & { esp: Esp | null }>> {
  const instances = await clientInstances(tag);
  const out: Array<InstanceCampaign & { esp: Esp | null }> = [];
  for (const instance of instances) {
    const camps = await listCampaignsCached(instance, { search: `${tag}:` });
    for (const c of camps) {
      if (isCanonicalNurtureCampaign(c.name)) {
        out.push({ ...c, instance, esp: detectCampaignEsp(c.name) });
      }
    }
  }
  return out;
}

export interface MainCompletion {
  total: number; // Σ original leads across counted main campaigns
  contacted: number; // Σ leads contacted
  pct: number; // contacted / total, or 1 when there are no loaded mains
  counted: number; // how many main campaigns contributed
}

/**
 * Aggregate main-campaign completion for a client tag.
 *
 * Denominator = ALL "loaded" main campaigns — status != draft AND total_leads > 0
 * (active + paused + completed), summed across both instances. This is the
 * 80%-gate metric. If the client has no loaded main campaigns, we treat it as
 * done (`pct = 1`) so nurture isn't held back forever.
 */
export async function mainCompletion(tag: string): Promise<MainCompletion> {
  const mains = await listMainCampaigns(tag);
  let total = 0;
  let contacted = 0;
  let counted = 0;
  for (const m of mains) {
    if (String(m.status).toLowerCase() === "draft") continue;
    const d = await getCampaignDetails(m.instance, m.id);
    if (!d) continue;
    const t = d.total_leads ?? 0;
    if (t <= 0) continue;
    total += t;
    contacted += d.total_leads_contacted ?? 0;
    counted += 1;
  }
  const pct = total > 0 ? contacted / total : 1;
  return { total, contacted, pct, counted };
}
