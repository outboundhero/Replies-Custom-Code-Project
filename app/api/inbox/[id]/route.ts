import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";

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

    return NextResponse.json(data);
  } catch (error) {
    console.error("[api/inbox/[id]] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch reply" }, { status: 500 });
  }
}
