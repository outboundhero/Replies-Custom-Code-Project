/**
 * One-time: archive every ACTIVE reply that arrived BEFORE the 4:45 PM Pacific
 * cutover, so the inbox is cleared of old replies and only shows new ones that
 * came in after the cutover. Nothing is deleted — this only flips
 * archived=false → true + stamps archived_at, and every reply stays
 * searchable/restorable in the Archive UI.
 *
 * Cut column: `created_at` = when the reply landed in Reply Router (its arrival
 * in the inbox). Rows with created_at < CUTOFF are archived; created_at >= CUTOFF
 * stay active (the "new" replies you want to see).
 *
 * CUTOFF: 4:45 PM Pacific on 2026-08-03 — the day the Airtable part was removed
 * (commit 427a21b pushed ~23:50 UTC that day). August is Pacific DAYLIGHT time
 * (PDT = UTC-7), so 16:45 PDT = 23:45 UTC. Adjust CUTOFF_UTC if the moment differs.
 *
 * Strategy: bounded id-WINDOW updates (same as archive-all-active.ts). A plain
 * table-wide UPDATE times out at this row count; walking the PK range in fixed
 * windows keeps every statement index-bounded. Idempotent.
 *
 *   # DRY RUN (counts only — shows how many will be archived vs stay active):
 *   tsx --env-file=.env.local scripts/archive-before-cutover.ts
 *
 *   # APPLY:
 *   tsx --env-file=.env.local scripts/archive-before-cutover.ts --apply
 */
import supabase from "@/lib/supabase";

// 4:45 PM PDT (UTC-7) on 2026-08-03 (Airtable-removal day) → 23:45 UTC.
const CUTOFF_UTC = "2026-08-03T23:45:00Z";
const WINDOW = 5000; // id span per UPDATE
const APPLY = process.argv.includes("--apply");

async function idBound(ascending: boolean): Promise<number | null> {
  const { data } = await supabase.from("replies").select("id").order("id", { ascending }).limit(1);
  return (data?.[0]?.id as number | undefined) ?? null;
}

/** Count active (archived=false) rows on one side of the cutover. */
async function countActive(side: "before" | "after" | "all"): Promise<number> {
  const base = supabase.from("replies").select("id", { count: "exact", head: true }).eq("archived", false);
  const q = side === "before" ? base.lt("created_at", CUTOFF_UTC)
    : side === "after" ? base.gte("created_at", CUTOFF_UTC)
    : base;
  const { count: c } = await q;
  return c ?? 0;
}

async function main() {
  console.log(`Cutover: ${CUTOFF_UTC}  (archive active replies with created_at < this)`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  // Preview the split so you can sanity-check before applying.
  const activeBefore = await countActive("before");
  const activeAfter = await countActive("after");
  console.log(`Active & BEFORE cutover (will be archived): ${activeBefore}`);
  console.log(`Active & AFTER  cutover (will stay active):  ${activeAfter}\n`);

  if (!APPLY) {
    console.log("Dry run only. Re-run with --apply to archive the pre-cutover replies.");
    return;
  }

  const nowIso = new Date().toISOString();
  const minId = await idBound(true);
  const maxId = await idBound(false);
  if (minId == null || maxId == null) { console.log("no rows"); return; }
  console.log(`id range ${minId} → ${maxId}, window ${WINDOW}`);

  const t0 = Date.now();
  let windows = 0;
  for (let lo = minId; lo <= maxId; lo += WINDOW) {
    const hi = lo + WINDOW;
    // Bounded by the PK range; only flips rows still active AND before the cutover.
    const { error } = await supabase
      .from("replies")
      .update({ archived: true, archived_at: nowIso })
      .eq("archived", false)
      .lt("created_at", CUTOFF_UTC)
      .gte("id", lo)
      .lt("id", hi);
    if (error) throw new Error(`update [${lo},${hi}) failed: ${error.message}`);
    windows++;
    if (windows % 10 === 0) console.log(`  …through id ${hi} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }

  const activeNow = await countActive("all");
  const activePost = await countActive("after");
  console.log(`\n✓ Done in ${Math.round((Date.now() - t0) / 1000)}s.`);
  console.log(`  Active now: ${activeNow}  (of which ${activePost} are post-cutover)`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
