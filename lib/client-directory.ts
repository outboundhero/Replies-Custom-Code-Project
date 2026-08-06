/**
 * Client directory sync — the ONE place that rebuilds all per-client data sourced
 * from the onboarding spreadsheet's "Groups" tab:
 *   • group allocation  → Turso `client_groups`
 *   • churned status     → Turso `churned_clients` (Status=Churned AND date passed)
 *   • service areas      → Turso `client_service_area` (from the Onboarding Form)
 *
 * Shared by the cron (/api/cron/sync-client-groups) and the manual Move-Leads
 * "Sync from sheet" button (/api/groups/sync), so both do exactly the same work.
 */
import db from "@/lib/db";
import { fetchClientGroups } from "@/lib/google-sheets";
import { invalidateGroupCache } from "@/lib/nurture/group-routing";
import { rebuildChurnedClients } from "@/lib/churn";
import { syncServiceAreas } from "@/lib/service-area";

/** Full-replace `client_groups` from the Groups tab. Returns per-group counts. */
export async function rebuildClientGroups(): Promise<{ count: number; g1: number; g2: number }> {
  const groups = await fetchClientGroups();
  await db.execute(
    "CREATE TABLE IF NOT EXISTS client_groups (client_tag TEXT PRIMARY KEY, group_num INTEGER NOT NULL, synced_at TEXT)",
  );
  const now = new Date().toISOString();
  await db.execute("DELETE FROM client_groups");
  const entries = [...groups.entries()];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    await db.batch(
      chunk.map(([tag, g]) => ({
        sql: "INSERT OR REPLACE INTO client_groups (client_tag, group_num, synced_at) VALUES (?, ?, ?)",
        args: [tag, g, now],
      })),
      "write",
    );
  }
  invalidateGroupCache();
  const g1 = entries.filter(([, g]) => g === 1).length;
  const g2 = entries.filter(([, g]) => g === 2).length;
  return { count: entries.length, g1, g2 };
}

export interface DirectorySyncResult {
  groups: { count: number; g1: number; g2: number };
  churn: { count: number; tags: string[] };
  serviceArea: { count: number; withArea: number } | null;
}

/** Rebuild groups + churn + service areas from the sheet, in one call. */
export async function syncClientDirectory(): Promise<DirectorySyncResult> {
  const groups = await rebuildClientGroups();
  const churn = await rebuildChurnedClients();
  const serviceArea = await syncServiceAreas()
    .then((r) => ({ count: r.count, withArea: r.withArea }))
    .catch(() => null); // service-area failure must not fail the group/churn sync
  return { groups, churn, serviceArea };
}
