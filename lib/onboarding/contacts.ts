/**
 * A client's contact emails — the people its lead hand-offs go to.
 *
 * Resolved the way LeadSync's whitelist email resolves them (it reads
 * GET /api/config/clients/[tag] here): the client's CC list is who an email TO
 * the client is addressed to, its BCC list is copied blind, and a client with
 * regional routes (BBS) includes every route's contacts. Someone on both lists
 * is kept once, in To.
 */
import db from "@/lib/db";
import { BBS_TAGS, bbsRoutes } from "@/lib/processing/bbs-router";

export interface ClientContacts {
  /** false = the tag isn't set up under Clients at all (LeadSync would get a 404). */
  known: boolean;
  to: string[];
  bcc: string[];
}

export async function clientContacts(tag: string): Promise<ClientContacts> {
  const TAG = tag.trim().toUpperCase();
  // Same join as the config endpoint, so "known" here is what LeadSync sees.
  const r = await db.execute({
    sql: `SELECT cc.cc_email_1, cc.cc_email_2, cc.cc_email_3, cc.cc_email_4, cc.cc_email_5, cc.cc_email_6,
                 cc.bcc_email_1, cc.bcc_email_2
          FROM client_tags ct
          JOIN sections s ON ct.section_id = s.id
          LEFT JOIN client_config cc ON cc.client_tag = ct.tag
          WHERE ct.tag = ?`,
    args: [TAG],
  });
  if (r.rows.length === 0) return { known: false, to: [], bcc: [] };
  const row = r.rows[0] as Record<string, unknown>;
  const slots = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => String(row[`${prefix}_email_${i + 1}`] ?? "").trim()).filter(Boolean);
  const routes = BBS_TAGS.includes(TAG) ? bbsRoutes() : [];
  const once = (list: string[]) => {
    const seen = new Set<string>();
    return list.filter((e) => { const k = e.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  const to = once([...slots("cc", 6), ...routes.flatMap((x) => x.cc.map((c) => String(c.email ?? "").trim()).filter(Boolean))]);
  const inTo = new Set(to.map((e) => e.toLowerCase()));
  const bcc = once(slots("bcc", 2)).filter((e) => !inTo.has(e.toLowerCase()));
  return { known: true, to, bcc };
}
