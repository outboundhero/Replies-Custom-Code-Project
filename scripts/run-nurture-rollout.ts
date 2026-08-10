/**
 * One-time nurture rollout: run the 80% activation gate + apply the +4h offset
 * across every active, non-churned client.
 *
 *   npx tsx --env-file=.env.local scripts/run-nurture-rollout.ts --dry     # preview
 *   npx tsx --env-file=.env.local scripts/run-nurture-rollout.ts           # apply
 *   ... --gate-only | --offset-only
 *
 * The gate: pauses under-80% active nurture, marks >=80% clients fired (leaves
 * them on). The offset: sets every nurture campaign's start = main start +4h
 * (keeping main's end) — this is what covers the [Nurture 2..N] clones the
 * client can't reach. Idempotent + safe to re-run.
 */
import { runActivationGate } from "@/lib/nurture/activation-gate";
import { applyOffsetForClient } from "@/lib/nurture/nurture-schedule";
import { getAllClientInstances } from "@/lib/nurture/group-routing";
import { getChurnedTags } from "@/lib/churn";

const args = new Set(process.argv.slice(2));
const dry = args.has("--dry");
const gateOnly = args.has("--gate-only");
const offsetOnly = args.has("--offset-only");

async function main() {
  console.log(`=== Nurture rollout ${dry ? "(DRY RUN — no changes)" : "(APPLYING)"} ===\n`);

  if (!offsetOnly) {
    console.log("--- 80% ACTIVATION GATE ---");
    const gate = await runActivationGate({ dryRun: dry, maxMs: dry ? 3_600_000 : 3_000_000 });
    const tally: Record<string, number> = {};
    for (const r of gate.results) tally[r.action] = (tally[r.action] ?? 0) + 1;
    console.log(`  checked ${gate.checked} tags; softBudgetHit=${gate.softBudgetHit}`);
    console.log(`  tally:`, JSON.stringify(tally));
    // Notable rows
    for (const r of gate.results) {
      if (r.action === "fired-activated" || r.action === "fired-no-mains")
        console.log(`   🔥 ${r.tag} fired @ ${r.pct != null ? (r.pct * 100).toFixed(1) + "%" : "?"} (${r.contacted}/${r.total})${r.activated ? ` — activated ${r.activated}` : ""}`);
      else if (r.action === "paused")
        console.log(`   ⏸  ${r.tag} paused ${r.paused} nurture @ ${r.pct != null ? (r.pct * 100).toFixed(1) + "%" : "?"}`);
      else if (r.action === "error")
        console.log(`   ⚠  ${r.tag} ERROR: ${r.error}`);
    }
    console.log("");
  }

  if (!gateOnly) {
    console.log("--- +4h START OFFSET ---");
    const all = await getAllClientInstances();
    const churned = await getChurnedTags();
    const tags = [...all.keys()].filter((t) => !churned.has(t.toUpperCase()));
    let applied = 0, skipped = 0, clients = 0;
    for (const tag of tags) {
      try {
        const r = await applyOffsetForClient(tag, { dryRun: dry });
        if (r.applied.length || r.skipped.length) {
          clients++;
          applied += r.applied.length;
          skipped += r.skipped.length;
          const sample = r.applied.slice(0, 3).map((a) => `${a.name.split(":")[1]?.trim() || a.name} ${a.from}→${a.to}`).join(", ");
          console.log(`   ${tag}: ${r.applied.length} offset${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}${sample ? ` [${sample}]` : ""}`);
        }
      } catch (e) {
        console.log(`   ⚠  ${tag} offset ERROR: ${(e as Error).message}`);
      }
    }
    console.log(`\n  offset ${dry ? "would apply to" : "applied to"} ${applied} nurture campaigns across ${clients} clients (${skipped} skipped)`);
  }

  console.log("\nDONE");
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
