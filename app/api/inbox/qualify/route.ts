/**
 * POST /api/inbox/qualify  { id }
 *
 * Runs (or re-runs) the qualification audit for a single reply on demand — the
 * same enrichment + industry + location + cross-client matching the ingest flow
 * runs, writing industry_audit / location_audit / qualification_reason /
 * suggested_client to Supabase (and the matching Airtable record). Used by the
 * inbox "Run Audit" button so leads whose audit failed / never ran at ingest
 * (or that need refreshing) can be audited by the team.
 *
 * Heavier than a normal mutate (web search + a few Gemini calls), so it gets its
 * own route with a longer maxDuration.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { qualifyLead } from "@/lib/qualification/qualify-lead";

export const maxDuration = 60;

const AIRTABLE_TABLE_ID = "tbl1BnpnsUBrBGeuy"; // shared across all section bases

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

    const { data: r, error } = await supabase
      .from("replies")
      .select("client_tag, company_name, city, state, address, google_maps_url, phone, lead_email, from_email, reply_we_got, email_subject, airtable_record_id, airtable_base_id")
      .eq("id", id)
      .single();
    if (error || !r) return NextResponse.json({ error: "Reply not found" }, { status: 404 });

    // Per-user client scoping.
    const allowed = session?.allowedClientTags ?? null;
    if (allowed?.length && (!r.client_tag || !allowed.includes(r.client_tag))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!r.client_tag || r.client_tag === "N/A") {
      return NextResponse.json({ ok: false, error: "This lead has no client tag to audit against." }, { status: 400 });
    }

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
      // Audit keys on the Supabase row id — Airtable-independent. Airtable record
      // ids are passed only if still present (the Airtable write is a no-op).
      replyRowId: Number(id),
      recordId: (r.airtable_record_id as string) || undefined,
      airtableBaseId: (r.airtable_base_id as string) || undefined,
      airtableTableId: r.airtable_record_id ? AIRTABLE_TABLE_ID : undefined,
    });

    // Return the freshly-written audit fields so the inbox can merge them into
    // the open detail WITHOUT a full reload (which would clobber the reply draft).
    // Core fields only (always exist); the optional audit_* columns are picked up
    // on the next detail load once the migration is run.
    const { data: after } = await supabase
      .from("replies")
      .select("industry_audit, location_audit, qualification_reason, suggested_client")
      .eq("id", id)
      .single();

    return NextResponse.json({ ok: true, audit: after || {} });
  } catch (e) {
    console.error("[api/inbox/qualify] failed:", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
