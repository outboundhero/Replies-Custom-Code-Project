/**
 * Instance-specific lead-id cache (Turso `nurture_instance_lead`). Records where
 * a lead physically lives after cross-instance placement, so the route engine
 * can attach it to a campaign without re-creating / re-looking-it-up.
 */
import db from "@/lib/db";

/** email(lowercased) → lead_id, for the given instance. Chunked IN query. */
export async function getInstanceLeadIds(instance: string, emails: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uniq = [...new Set(emails.map((e) => e.toLowerCase()))];
  for (let i = 0; i < uniq.length; i += 200) {
    const chunk = uniq.slice(i, i + 200);
    const placeholders = chunk.map(() => "?").join(",");
    try {
      const res = await db.execute({
        sql: `SELECT email, lead_id FROM nurture_instance_lead WHERE bison_instance = ? AND email IN (${placeholders})`,
        args: [instance, ...chunk],
      });
      for (const r of res.rows) out.set(String(r.email).toLowerCase(), Number(r.lead_id));
    } catch { /* table missing → empty */ }
  }
  return out;
}

/** Upsert (instance, email) → lead_id records. */
export async function recordInstanceLeads(
  instance: string,
  clientTag: string,
  rows: Array<{ email: string; id: number }>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    try {
      await db.batch(chunk.map((r) => ({
        sql: "INSERT INTO nurture_instance_lead (bison_instance, email, lead_id, client_tag, updated_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(bison_instance, email) DO UPDATE SET lead_id=excluded.lead_id, client_tag=excluded.client_tag, updated_at=datetime('now')",
        args: [instance, r.email.toLowerCase(), r.id, clientTag],
      })), "write");
    } catch { /* table missing — ignore */ }
  }
}
