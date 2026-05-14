import { NextRequest, NextResponse } from "next/server";
import { requireAuth, getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { getSheetForClient } from "@/lib/google-sheets-registry";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const { id } = await params;
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
    const session = await getSession();
    const allowed = session?.allowedClientTags ?? null;
    if (allowed && allowed.length && (!data.client_tag || !allowed.includes(data.client_tag))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Look up the client's Google Sheet URL via the canonical external
    // registry (https://google-sheets-dashboard-nine.vercel.app).
    let sheet_url: string | null = null;
    if (data.client_tag && data.client_tag !== "N/A") {
      const sheet = await getSheetForClient(data.client_tag);
      if (sheet?.id) {
        sheet_url = `https://docs.google.com/spreadsheets/d/${sheet.id}`;
      }
    }

    return NextResponse.json({ ...data, sheet_url });
  } catch (error) {
    console.error("[api/inbox/[id]] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch reply" }, { status: 500 });
  }
}
