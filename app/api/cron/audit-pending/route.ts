/**
 * GET /api/cron/audit-pending
 *
 * Reliably runs the qualification audit for positive-AI-category leads that
 * don't have one yet. The webhook fires the audit at ingest (fire-and-forget),
 * but Vercel can freeze the function right after the response, so some audits
 * never finish. This cron is the safety net: it picks up any positive-category
 * lead with an Airtable record and no industry audit and audits it — so every
 * such lead ends up audited automatically, and the backlog clears itself.
 *
 * Bounded per run so a burst can't blow the time/AI budget. Auth: CRON_SECRET.
 */
import { NextRequest, NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { qualifyLead } from "@/lib/qualification/qualify-lead";
import { logError } from "@/lib/errors";

export const maxDuration = 300;

const AIRTABLE_TABLE_ID = "tbl1BnpnsUBrBGeuy"; // shared across all section bases
// AI categories that get audited at ingest (must match lib/processing/tracked.ts).
const QUALIFYING_CATEGORIES = ["Interested", "Meeting Request", "Referral Given", "Internally Forwarded"];
const QUALIFYING_CONTAINS = ["Follow Up", "Unrecognizable"];
const PER_RUN = 12;        // leads audited per invocation
const CONCURRENCY = 3;     // parallel audits (each does enrichment + a couple AI calls)
const SOFT_BUDGET_MS = 4.5 * 60 * 1000;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();

  // Newest-first: a positive-category lead, not yet audited. No longer requires
  // an Airtable link (leads have none post-cutover) — the audit keys on the
  // Supabase row id. This is the backstop for any ingest audit that failed.
  const { data: rows, error } = await supabase
    .from("replies")
    .select("id, client_tag, company_name, city, state, address, google_maps_url, phone, lead_email, from_email, reply_we_got, email_subject, airtable_record_id, airtable_base_id, bison_instance, ai_categorized_lead_category")
    .in("ai_categorized_lead_category", QUALIFYING_CATEGORIES)
    .is("industry_audit", null)
    .neq("client_tag", "N/A")
    .not("client_tag", "is", null)
    .order("reply_time", { ascending: false })
    .limit(PER_RUN * 4);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // The `.in(...)` above can't express the "contains Follow Up / Unrecognizable"
  // variants, but those AI labels already start with a QUALIFYING string in most
  // cases; include any extra contains-matches defensively.
  const eligible = (rows || []).filter((r) => {
    const c = String(r.ai_categorized_lead_category || "");
    return QUALIFYING_CATEGORIES.includes(c) || QUALIFYING_CONTAINS.some((p) => c.includes(p));
  }).slice(0, PER_RUN);

  let audited = 0, failed = 0;
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, eligible.length) }, async () => {
    while (idx < eligible.length) {
      if (Date.now() - startedAt > SOFT_BUDGET_MS) return;
      const r = eligible[idx++];
      try {
        await qualifyLead({
          campaignTag: r.client_tag as string,
          companyName: (r.company_name as string) || "",
          city: (r.city as string) || "",
          state: (r.state as string) || "",
          address: (r.address as string) || "",
          googleMapsUrl: (r.google_maps_url as string) || "",
          phone: String(r.phone || ""),
          linkedin: "",
          leadEmail: (r.lead_email as string) || (r.from_email as string) || "",
          replyText: (r.reply_we_got as string) || "",
          replySubject: (r.email_subject as string) || "",
          replyRowId: r.id as number,
          recordId: (r.airtable_record_id as string) || undefined,
          airtableBaseId: (r.airtable_base_id as string) || undefined,
          airtableTableId: r.airtable_record_id ? AIRTABLE_TABLE_ID : undefined,
          bisonInstance: (r.bison_instance as string) || undefined,
        });
        audited++;
      } catch (e) {
        failed++;
        await logError("audit-pending", `lead:${r.id}`, (e as Error).message, { tag: r.client_tag });
      }
    }
  }));

  return NextResponse.json({ ok: true, pendingSeen: eligible.length, audited, failed });
}
