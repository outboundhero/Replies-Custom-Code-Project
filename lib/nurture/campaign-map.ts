/**
 * Operator-confirmed target-campaign map. The nurture route engine sends leads
 * ONLY to the campaigns recorded here (per client × instance × ESP) — nothing
 * is auto-picked. A client is "routable" only once its map is confirmed
 * (client_config.nurture_map_confirmed_at is set), which gates Route-all,
 * Auto-route, and the auto-push cron.
 */
import db from "@/lib/db";
import type { Esp } from "@/lib/nurture/esp";

export interface CampaignMapEntry {
  bison_instance: string;
  esp: Esp;
  campaign_id: number;
  campaign_name: string | null;
  lane: string | null;
}

export async function getCampaignMap(clientTag: string): Promise<CampaignMapEntry[]> {
  const res = await db.execute({
    sql: "SELECT bison_instance, esp, campaign_id, campaign_name, lane FROM nurture_campaign_map WHERE UPPER(client_tag) = UPPER(?)",
    args: [clientTag],
  });
  return res.rows.map((r) => ({
    bison_instance: String(r.bison_instance),
    esp: String(r.esp) as Esp,
    campaign_id: Number(r.campaign_id),
    campaign_name: (r.campaign_name as string) ?? null,
    lane: (r.lane as string) ?? null,
  }));
}

export async function getMapConfirmedAt(clientTag: string): Promise<string | null> {
  try {
    const res = await db.execute({
      sql: "SELECT nurture_map_confirmed_at FROM client_config WHERE UPPER(client_tag) = UPPER(?)",
      args: [clientTag],
    });
    return (res.rows[0]?.nurture_map_confirmed_at as string) ?? null;
  } catch {
    return null; // column not migrated yet
  }
}

/** Target campaign for a given (instance, ESP), or null if unmapped. */
export function pickFromMap(map: CampaignMapEntry[], instance: string, esp: Esp): CampaignMapEntry | null {
  return map.find((m) => m.bison_instance === instance && m.esp === esp) ?? null;
}
