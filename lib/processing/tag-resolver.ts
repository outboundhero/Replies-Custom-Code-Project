import db from "@/lib/db";
import type { Section } from "@/lib/types";

/**
 * Extract the client tag from a tracked campaign name.
 * Campaign names follow the format "TAG: rest of campaign name"
 */
export function extractTagFromCampaignName(campaignName: string): string {
  const matches = campaignName.match(/^(.*?):/);
  return matches ? matches[1].trim() : "";
}

/**
 * Resolve which section a client tag belongs to.
 * Returns the section config or null if unroutable.
 */
export async function resolveSection(tag: string): Promise<Section | null> {
  const result = await db.execute({
    sql: `SELECT s.* FROM client_tags ct
          JOIN sections s ON ct.section_id = s.id
          WHERE ct.tag = ?`,
    args: [tag],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id as number,
    name: row.name as string,
    airtable_base_id: row.airtable_base_id as string,
    airtable_table_id: row.airtable_table_id as string,
    meeting_ready_table_id: row.meeting_ready_table_id as string,
    clay_webhook_url_tracked: row.clay_webhook_url_tracked as string | null,
    created_at: row.created_at as string,
  };
}
