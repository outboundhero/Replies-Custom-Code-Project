/**
 * Drain the READY-lead backlog now — push every confirmed client's eligible,
 * ESP-resolved ready leads into their nurture campaigns, uncapped, locally (no
 * serverless timeout). Runs the same engine as the auto-push cron
 * (runAutoPushForClient) but loops each client to exhaustion instead of the
 * cron's ~1k/tick cap. After this, the cron only has the daily trickle to handle.
 *
 *   npx tsx scripts/drain-ready-leads.ts                 # all confirmed+enabled clients
 *   node --env-file=.env.local --import tsx scripts/drain-ready-leads.ts --tags SBSSE,JPM
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import db from "@/lib/db";
import { runAutoPushForClient } from "@/lib/nurture/auto-push";
import { getChurnedTags } from "@/lib/churn";

const argv = process.argv.slice(2);
const flag = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

(async () => {
  const res = await db.execute(
    `SELECT ct.tag FROM client_tags ct JOIN client_config cc ON cc.client_tag = ct.tag
     WHERE cc.nurture_map_confirmed_at IS NOT NULL AND COALESCE(cc.auto_nurture_disabled, 0) = 0`,
  );
  const churned = await getChurnedTags();
  let tags = res.rows.map((r) => String(r.tag)).filter((t) => !churned.has(t.toUpperCase()));
  if (flag("--tags")) tags = flag("--tags")!.split(",").map((s) => s.trim().toUpperCase());

  console.log(`Draining ready leads for ${tags.length} confirmed+enabled clients…\n`);
  let grand = 0;
  for (const tag of tags) {
    let seqAfterId = 0, repAfterId = 0, legAfterId = 0, attached = 0, pages = 0, err = "";
    for (;;) {
      if (pages++ >= 3000) break; // safety
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await runAutoPushForClient(tag, { cap: 1000, seqAfterId, repAfterId, legAfterId });
      attached += r.totalAttached || 0;
      seqAfterId = r.nextSeqAfterId; repAfterId = r.nextRepAfterId; legAfterId = r.nextLegAfterId;
      if (r.error) { err = r.error; break; }
      if (r.exhausted) break;
    }
    grand += attached;
    if (attached > 0 || err) console.log(`  ${tag.padEnd(8)} attached ${attached.toLocaleString()}${err ? `  ⚠ ${err}` : ""}`);
  }
  console.log(`\n✅ GRAND TOTAL attached: ${grand.toLocaleString()}`);
})().then(() => process.exit(0)).catch((e) => { console.error("FATAL", e); process.exit(1); });
