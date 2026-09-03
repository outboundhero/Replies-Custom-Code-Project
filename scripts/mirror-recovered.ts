/**
 * Reconciliation: mirror every already-recovered stopped lead (Turso
 * nurture_stopped_recovered) into Supabase nurture_sequence_finished as
 * already-added, so the Nurture dashboard reflects them and the finished Auto
 * Route never re-routes them. Idempotent (upsert) — safe to re-run (e.g. after
 * the backfill adds more). Covers leads recovered before the mirror was wired in.
 *
 *   npx tsx -r dotenv/config scripts/mirror-recovered.ts dotenv_config_path=.env.local
 */
import db from "@/lib/db";
import { mirrorRecoveredToFinished } from "@/lib/nurture/recover-stopped";

async function main() {
  const res = await db.execute(
    "SELECT client_tag, email, ob_lead_id, bison_instance, esp, nurture_campaign_id, added_at FROM nurture_stopped_recovered WHERE added_at IS NOT NULL AND nurture_campaign_id IS NOT NULL",
  );
  const all = res.rows as unknown as Array<{ client_tag: string; email: string; ob_lead_id: number | null; bison_instance: string | null; esp: string; nurture_campaign_id: number; added_at: string }>;
  console.log(`ledger rows to mirror: ${all.length}`);

  // Group by (client_tag, nurture_campaign_id) — mirror uses the target campaign id.
  const groups = new Map<string, { tag: string; campaignId: number; rows: Array<{ email: string; obLeadId: number | null; sourceInstance: string | null; esp: string }>; stamp: string }>();
  for (const r of all) {
    const key = `${r.client_tag}::${r.nurture_campaign_id}`;
    if (!groups.has(key)) groups.set(key, { tag: r.client_tag, campaignId: r.nurture_campaign_id, rows: [], stamp: r.added_at });
    groups.get(key)!.rows.push({ email: r.email, obLeadId: r.ob_lead_id, sourceInstance: r.bison_instance, esp: r.esp });
  }

  let done = 0, mirrored = 0;
  for (const g of groups.values()) {
    try { await mirrorRecoveredToFinished(g.tag, g.campaignId, g.rows, g.stamp); mirrored += g.rows.length; }
    catch (e) { console.log(`  ERR ${g.tag}/#${g.campaignId}: ${(e as Error).message}`); }
    done++;
    if (done % 20 === 0) console.log(`  ...${done}/${groups.size} groups, ~${mirrored} leads mirrored`);
  }
  console.log(`DONE: mirrored ${mirrored} leads across ${groups.size} (client,campaign) groups`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
