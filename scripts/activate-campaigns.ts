/**
 * Fleet campaign activation: for every active (non-churned) client, find their
 * Main + Nurture campaigns that are draft/paused but SENDABLE (>=1 lead AND >=1
 * connected sender inbox) and resume them. Dry-run by default.
 *
 *   npx tsx -r dotenv/config scripts/activate-campaigns.ts dotenv_config_path=.env.local        # DRY
 *   npx tsx -r dotenv/config scripts/activate-campaigns.ts dotenv_config_path=.env.local LIVE   # activate
 * Optional: pass one or more TAGs to limit scope.
 */
import { listCampaigns, getCampaignSenderEmails, getCampaignLeadCount, resumeCampaign } from "@/lib/outboundhero-api";
import { getAllClientInstances } from "@/lib/nurture/group-routing";
import { getChurnedTags } from "@/lib/churn";
import { extractTagFromCampaignName } from "@/lib/processing/tag-resolver";

const LIVE = process.argv.includes("LIVE");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
    const ci = all.get(tag)!;
    const instances = Array.from(new Set([ci.b2b, ci.b2c]));
    const re = new RegExp(`^${esc(tag)}\\s*:`, "i");
    const lines: string[] = [];
    for (const inst of instances) {
      let cs;
      try { cs = (await listCampaigns(inst, { statuses: ["draft", "paused"], search: tag })).filter((c) => re.test(c.name || "")); }
      catch { continue; }
      for (const c of cs) {
        if ((extractTagFromCampaignName(c.name) || "").toUpperCase() !== tag) continue;
        const leads = c.total_leads ?? 0;
        let connected = 0;
        try { connected = (await getCampaignSenderEmails(inst, c.id)).filter((s) => String(s.status).toLowerCase() === "connected").length; } catch {}
        const kind = /\[nurture/i.test(c.name || "") ? "nurture" : "main";
        if (leads > 0 && connected > 0) {
          totActivatable++;
          if (LIVE) {
            const r = await resumeCampaign(inst, c.id);
            const ok = r.ok || /not paused|already (active|running|launched)|only paused or draft/i.test(`${r.error ?? ""} ${JSON.stringify(r.raw ?? "")}`);
            if (ok) { totActivated++; lines.push(`  ✅ ACTIVATED ${inst} #${c.id} "${c.name}" [${c.status}→active] ${kind} leads=${leads} inbox=${connected}`); }
            else lines.push(`  ⚠️ FAILED ${inst} #${c.id} "${c.name}": ${r.error}`);
          } else {
            lines.push(`  → WOULD ACTIVATE ${inst} #${c.id} "${c.name}" [${c.status}] ${kind} leads=${leads} inbox=${connected}`);
          }
        } else {
          totBlocked++;
          const reason = leads === 0 && connected === 0 ? "no leads + no inbox" : leads === 0 ? "no leads" : "no connected inbox";
          blockedByReason[reason] = (blockedByReason[reason] || 0) + 1;
          lines.push(`  ✗ blocked ${inst} #${c.id} "${c.name}" [${c.status}] ${kind}: ${reason} (leads=${leads} inbox=${connected})`);
        }
      }
    }
    if (lines.length) { console.log(`\n[${tag}] group ${ci.group}:`); lines.forEach((l) => console.log(l)); }
  });

  console.log(`\n=== SUMMARY (${LIVE ? "LIVE" : "DRY-RUN"}) ===`);
  console.log(`sendable draft/paused campaigns ${LIVE ? `— activated ${totActivated}/${totActivatable}` : `that WOULD activate: ${totActivatable}`}`);
  console.log(`blocked (can't send): ${totBlocked} — ${Object.entries(blockedByReason).map(([r, n]) => `${r}: ${n}`).join(", ")}`);
  console.log("=== DONE ===");
}
main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
