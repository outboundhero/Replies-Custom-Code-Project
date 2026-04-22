import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import supabase from "@/lib/supabase";

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

    // Look up the client's Google Sheet URL
    let sheet_url: string | null = null;
    if (data.client_tag && data.client_tag !== "N/A") {
      const { data: sheet } = await supabase
        .from("client_sheets")
        .select("sheet_id")
        .eq("client_tag", data.client_tag)
        .single();
      if (sheet?.sheet_id) {
        sheet_url = `https://docs.google.com/spreadsheets/d/${sheet.sheet_id}`;
      }
    }

    return NextResponse.json({ ...data, sheet_url });
  } catch (error) {
    console.error("[api/inbox/[id]] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch reply" }, { status: 500 });
  }
}
