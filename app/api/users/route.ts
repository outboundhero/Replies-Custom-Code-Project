import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { withCache, nsVersion } from "@/lib/server-cache";

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const data = await withCache(`users:list:v${nsVersion("users")}`, 60_000, async () => {
      const { data, error } = await supabase
        .from("app_users")
        .select("id, email, role, allowed_client_tags, created_at, updated_at")
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return data;
    });
    return NextResponse.json(data);
  } catch (error) {
    console.error("[api/users] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }
}
