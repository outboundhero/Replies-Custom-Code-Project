import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import supabase from "@/lib/supabase";

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const { data, error } = await supabase
      .from("app_users")
      .select("id, email, role, created_at, updated_at")
      .order("created_at", { ascending: true });

    if (error) throw new Error(error.message);
    return NextResponse.json(data);
  } catch (error) {
    console.error("[api/users] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }
}
