/**
 * One-time: move EVERY active reply (Open Response included) into the archive
 * so the inbox starts fresh. Nothing is deleted — this only flips archived=false
 * → true + stamps archived_at. Every reply stays searchable/restorable in the
 * Archive UI, and new incoming replies arrive active as normal.
 *
 * Strategy: bounded id-WINDOW updates. A plain "UPDATE … WHERE archived=false"
 * over the whole table times out, and selecting active ids ORDER BY id got slow
 * once active rows became sparse. Instead we walk the primary-key range in
 * fixed id windows and update archived=false rows within each window — every
 * statement is bounded by the PK index, so none can time out. Idempotent.
 *
 *   tsx --env-file=.env.local scripts/archive-all-active.ts
 */
import supabase from "@/lib/supabase";

const WINDOW = 5000; // id span per UPDATE

async function idBound(ascending: boolean): Promise<number | null> {
  const { data } = await supabase.from("replies").select("id").order("id", { ascending }).limit(1);
  return (data?.[0]?.id as number | undefined) ?? null;
}

async function main() {
  const nowIso = new Date().toISOString();
  const minId = await idBound(true);
  const maxId = await idBound(false);
  if (minId == null || maxId == null) { console.log("no rows"); return; }
  console.log(`id range ${minId} → ${maxId}, window ${WINDOW}`);

  const t0 = Date.now();
  let windows = 0;
  for (let lo = minId; lo <= maxId; lo += WINDOW) {
    const hi = lo + WINDOW;
    // Bounded by the PK range; only flips rows still active.
    const { error } = await supabase
      .from("replies")
      .update({ archived: true, archived_at: nowIso })
      .eq("archived", false)
      .gte("id", lo)
      .lt("id", hi);
    if (error) throw new Error(`update [${lo},${hi}) failed: ${error.message}`);
    windows++;
    if (windows % 10 === 0) console.log(`  …through id ${hi} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }

  const active = await supabase.from("replies").select("id", { count: "exact", head: true }).eq("archived", false);
  const archived = await supabase.from("replies").select("id", { count: "planned", head: true }).eq("archived", true);
  console.log(`\n✓ Done in ${Math.round((Date.now() - t0) / 1000)}s.`);
  console.log(`  Active now: ${active.count}  |  Archived now: ${archived.count}`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
