/**
 * Close.com CRM push for OutboundHero (OH).
 *
 * Replaces the Airtable automation that created a Close.com lead when an OH reply
 * was marked "Interested" / "Needs Review". In ReplyRouter it fires from the inbox
 * category change (manual categorization) — see app/api/inbox/mutate/route.ts.
 *
 * - Skips OH's own existing-customer domains (hardcoded below).
 * - Dedupes so a lead is only created ONCE per reply (Turso `close_crm_pushed`).
 * - Auth: Close.com uses HTTP Basic with the API key as the username + empty
 *   password → `Basic base64("<key>:")`. Add the RAW key to Vercel as CLOSE_API_KEY.
 */
import db from "@/lib/db";

// OH's own customers / existing contacts — never (re)created in Close.com.
// (Editable constant, per decision. Mirror of the Airtable trigger's domain filter.)
const OH_CLOSE_EXCLUDED_DOMAINS = new Set([
  "blumontservices.com",
  "nashvillebhs.com",
  "hurricanecleaning.com",
  "ahlersbuildingmaintenance.com",
  "hygeiaservices.com",
  "imc.cleaning",
  "broomday.com",
  "summitfacilitysolutions.com",
  "twobrotherschristmas.com",
]);

/** Working `lead_category` values that trigger the OH → Close.com push. */
export const OH_CLOSE_CATEGORIES = new Set(["Interested", "Needs Review"]);

// The Close.com custom field that tags the lead source as OutboundHero.
const CLOSE_SOURCE_FIELD = "custom.cf_C9YGqiYOw9CyHyB6Hjf7AtXe7NJscn6FXBdab3BDqJW";

function domainOf(email: string): string {
  const at = (email || "").lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

export function isOhCloseExcluded(email: string | null | undefined): boolean {
  return OH_CLOSE_EXCLUDED_DOMAINS.has(domainOf(String(email || "")));
}

interface CloseLeadInput {
  name: string;
  email: string;
  phone?: string | null;
  website?: string | null;
  orgName?: string | null;
}

/** Create a lead in Close.com. Returns the new lead id on success. */
export async function createCloseLead(lead: CloseLeadInput): Promise<{ ok: boolean; id?: string; error?: string }> {
  const rawKey = process.env.CLOSE_API_KEY;
  if (!rawKey) return { ok: false, error: "CLOSE_API_KEY not set" };
  // Accept either key form: a RAW "api_…" key (Close uses Basic with the key as the
  // username + empty password → base64("<key>:")), OR an already-base64-encoded
  // Basic value (used as-is — this is what the Airtable setup provided).
  const auth = rawKey.startsWith("api_")
    ? `Basic ${Buffer.from(`${rawKey}:`).toString("base64")}`
    : `Basic ${rawKey}`;

  const payload: Record<string, unknown> = {
    name: lead.name,
    contacts: [{
      name: lead.name,
      emails: [{ email: lead.email, type: "office" }],
      ...(lead.phone ? { phones: [{ phone: lead.phone, type: "office" }] } : {}),
    }],
    ...(lead.website ? { url: lead.website } : {}),
    ...(lead.orgName ? { organization_name: lead.orgName } : {}),
    [CLOSE_SOURCE_FIELD]: "OutboundHero",
  };

  try {
    const res = await fetch("https://api.close.com/api/v1/lead/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: auth },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 300)}` };
    const data = await res.json().catch(() => ({}));
    return { ok: true, id: typeof data?.id === "string" ? data.id : undefined };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function alreadyPushed(replyId: number): Promise<boolean> {
  try {
    await db.execute("CREATE TABLE IF NOT EXISTS close_crm_pushed (reply_id INTEGER PRIMARY KEY, close_lead_id TEXT, pushed_at TEXT)");
    const r = await db.execute({ sql: "SELECT reply_id FROM close_crm_pushed WHERE reply_id = ?", args: [replyId] });
    return r.rows.length > 0;
  } catch {
    return false; // never block the push on a dedup-read failure
  }
}

/**
 * Orchestrator: create the OH lead in Close.com once, skipping excluded domains
 * and duplicates. Caller has already checked client_tag=OH + qualifying category.
 */
export async function pushOhLeadToClose(reply: Record<string, unknown>): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const replyId = Number(reply.id);
  const email = String(reply.lead_email || "").trim();
  if (!email) return { ok: false, skipped: "no email" };
  if (isOhCloseExcluded(email)) return { ok: false, skipped: "excluded domain" };
  if (await alreadyPushed(replyId)) return { ok: true, skipped: "already in Close" };

  const name =
    String(reply.lead_name || "").trim() ||
    `${reply.first_name || ""} ${reply.last_name || ""}`.trim() ||
    email;

  const result = await createCloseLead({
    name,
    email,
    phone: (reply.phone as string | null) ?? null,
    orgName: (reply.company_name as string | null) ?? null,
  });
  if (!result.ok) return { ok: false, error: result.error };

  try {
    await db.execute({
      sql: "INSERT OR IGNORE INTO close_crm_pushed (reply_id, close_lead_id, pushed_at) VALUES (?, ?, ?)",
      args: [replyId, result.id ?? null, new Date().toISOString()],
    });
  } catch { /* dedup write best-effort */ }
  return { ok: true };
}
