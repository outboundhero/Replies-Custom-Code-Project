/**
 * Fleet campaign activation: for every active (non-churned) client, find their
 * Main + Nurture campaigns that are draft/paused but SENDABLE (>=1 lead AND >=1
 * connected sender inbox) and resume them. Dry-run by default.
 *
 *   npx tsx -r dotenv/config scripts/activate-campaigns.ts dotenv_config_path=.env.local        # DRY
 *   npx tsx -r dotenv/config scripts/activate-campaigns.ts dotenv_config_path=.env.local LIVE   # activate
 * Optional: pass one or more TAGs to limit scope.
 */
import { listCampaigns, resumeCampaign } from "@/lib/outboundhero-api";
import { getInstanceConfig } from "@/lib/bison-instances";
import { getAllClientInstances } from "@/lib/nurture/group-routing";
import { getChurnedTags } from "@/lib/churn";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";

const LIVE = process.argv.includes("LIVE");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Fast "does this client have >=1 connected inbox on this instance?" — read only
// the first page of the campaign's tag-scoped sender pool (same pool for all the
// client's campaigns on the instance), not the whole paginated list.
async function hasConnectedInbox(inst: string, campaignId: number): Promise<boolean> {
  try {
    const { baseUrl, token } = getInstanceConfig(inst);
    const res = await fetch(`${baseUrl}/api/campaigns/${campaignId}/sender-emails?per_page=100`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) return false;
    const d = await res.json().catch(() => null);
    return ((d?.data ?? []) as Array<{ status?: string }>).some((s) => String(s.status).toLowerCase() === "connected");
  } catch { return false; }
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function main() {
  const argTags = process.argv.slice(2).filter((a) => /^[A-Z0-9&]+$/i.test(a) && a !== "LIVE").map((a) => a.toUpperCase());
  const all = await getAllClientInstances();
  const churned = await getChurnedTags();
  let tags = [...all.keys()].map((t) => t.toUpperCase()).filter((t) => !churned.has(t)).sort();
  if (argTags.length) tags = tags.filter((t) => argTags.includes(t));

  console.log(`=== Campaign activation (${LIVE ? "LIVE" : "DRY-RUN"}) — ${tags.length} active clients ===`);
  let totActivatable = 0, totActivated = 0, totBlocked = 0;
  const blockedByReason: Record<string, number> = {};

  await pool(tags, 3, async (tag) => {
   try {
    const ci = all.get(tag)!;
    const instances = Array.from(new Set([ci.b2b, ci.b2c]));
    const re = new RegExp(`^${esc(tag)}\\s*:`, "i");
    const lines: string[] = [];
    for (const inst of instances) {
      let cs;
      try { cs = (await listCampaigns(inst, { statuses: ["draft", "paused"], search: tag })).filter((c) => re.test(c.name || "")); }
      catch { continue; }
      // Connected-inbox status is the same tag pool for all this client's
      // campaigns on the instance → resolve it once (fast page-1 check).
      let inboxOk: boolean | null = null;
      for (const c of cs) {
        if ((extractTagFromCampaignName(c.name) || "").toUpperCase() !== tag) continue;
        const leads = c.total_leads ?? 0;
        if (inboxOk === null) inboxOk = await hasConnectedInbox(inst, c.id);
        const kind = /\[nurture/i.test(c.name || "") ? "nurture" : "main";
        if (leads > 0 && inboxOk) {
          totActivatable++;
          if (LIVE) {
            const r = await resumeCampaign(inst, c.id);
            const ok = r.ok || /not paused|already (active|running|launched)|only paused or draft/i.test(`${r.error ?? ""} ${JSON.stringify(r.raw ?? "")}`);
            if (ok) { totActivated++; lines.push(`  ✅ ACTIVATED ${inst} #${c.id} "${c.name}" [${c.status}→active] ${kind} leads=${leads}`); }
            else lines.push(`  ⚠️ FAILED ${inst} #${c.id} "${c.name}": ${r.error}`);
          } else {
            lines.push(`  → WOULD ACTIVATE ${inst} #${c.id} "${c.name}" [${c.status}] ${kind} leads=${leads}`);
          }
        } else {
          totBlocked++;
          const reason = leads === 0 && !inboxOk ? "no leads + no inbox" : leads === 0 ? "no leads" : "no connected inbox";
          blockedByReason[reason] = (blockedByReason[reason] || 0) + 1;
          lines.push(`  ✗ blocked ${inst} #${c.id} "${c.name}" [${c.status}] ${kind}: ${reason} (leads=${leads})`);
        }
      }
    }
    if (lines.length) { console.log(`\n[${tag}] group ${ci.group}:`); lines.forEach((l) => console.log(l)); }
   } catch (e) {
    console.log(`[${tag}] ERROR (skipped, will re-run cleanly): ${(e as Error).message}`);
   }
  });

  console.log(`\n=== SUMMARY (${LIVE ? "LIVE" : "DRY-RUN"}) ===`);
  console.log(`sendable draft/paused campaigns ${LIVE ? `— activated ${totActivated}/${totActivatable}` : `that WOULD activate: ${totActivatable}`}`);
  console.log(`blocked (can't send): ${totBlocked} — ${Object.entries(blockedByReason).map(([r, n]) => `${r}: ${n}`).join(", ")}`);
  console.log("=== DONE ===");
}
main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
