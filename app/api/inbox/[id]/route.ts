import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";
import db from "@/lib/db";
import { POSITIVE_AI_CATEGORIES } from "@/lib/inbox-views";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Single session read (was requireAuth() + getSession() = two JWT verifies).
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await params;
    // Just the row (indexed primary-key lookup — fast). The Google-Sheet URL
    // is fetched separately via /api/client-sheet so a cold external registry
    // call never blocks the detail from rendering.
    const { data, error } = await supabase
      .from("replies")
      .select("*")
      .eq("id", Number(id))
      .single();

    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Per-user client scoping: a scoped user can't open a reply that
    // belongs to a tag outside their allowed list. Return 404 (not 403)
    // so we don't leak the existence of the row.
    const allowed = session?.allowedClientTags ?? null;
    if (allowed && allowed.length && (!data.client_tag || !allowed.includes(data.client_tag))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // For AI-positive leads, overlay the client's CURRENT CC/BCC from client_config
    // onto the row so the composer always loops in the client team — even when the
    // ingest snapshot on the row was empty/stale (the ingest copy is gated on a
    // different AI-category set and never reflects later Clients-section edits).
    // Best-effort: a config miss/error must never break the detail load.
    try {
      const aiCat = String(data.ai_categorized_lead_category || "");
      const tag = String(data.client_tag || "");
      if (tag && tag !== "N/A" && POSITIVE_AI_CATEGORIES.includes(aiCat)) {
        const cfg = await db.execute({
          sql: `SELECT cc_name_1, cc_email_1, cc_name_2, cc_email_2, cc_name_3, cc_email_3,
                       cc_name_4, cc_email_4, cc_name_5, cc_email_5, cc_name_6, cc_email_6,
                       bcc_name_1, bcc_email_1, bcc_name_2, bcc_email_2
                FROM client_config WHERE client_tag = ?`,
          args: [tag],
        });
        const row = cfg.rows[0];
        if (row) for (const k of Object.keys(row)) data[k] = row[k as keyof typeof row] ?? null;
      }
    } catch { /* keep the row's snapshot columns */ }

    return NextResponse.json(data);
  } catch (error) {
    console.error("[api/inbox/[id]] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch reply" }, { status: 500 });
  }
}
