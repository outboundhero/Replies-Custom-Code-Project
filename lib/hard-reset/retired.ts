/**
 * Campaigns a reset archived (Hard reset or Nurture reset), as "instance:id".
 *
 * Email Bison has been seen turning such a campaign back from "archived" to "completed" on its own
 * (OutboundHero instance, JPLV + FSD, 2026-10-23 — hours after the reset archived them). Reply Router
 * keeps treating them as archived whatever Bison shows: the auto-map never picks one (it has the same
 * name as the new campaign that replaced it) and the Nurture page doesn't show it as a current batch.
 */
import db from "@/lib/db";

/** Read fresh each time (a few dozen small rows), so a campaign counts as retired the moment a reset archives it. */
export async function resetRetiredCampaigns(): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const rows = (await db.execute("SELECT archived_json FROM hard_reset WHERE archived_json IS NOT NULL")).rows;
    for (const r of rows) {
      let list: Array<{ instance?: string; id?: number; result?: string }> = [];
      try { list = JSON.parse(String(r.archived_json)); } catch { continue; }
      for (const a of Array.isArray(list) ? list : []) {
        if (a?.instance && a.id != null && (a.result === "archived" || a.result === "already")) set.add(`${a.instance}:${a.id}`);
      }
    }
  } catch { /* no resets table yet */ }
  return set;
}
