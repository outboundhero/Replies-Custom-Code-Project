/**
 * GET /api/onboarding/users — lightweight app-user list (email + role).
 * Admin-only, like the rest of onboarding.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { withCache, nsVersion } from "@/lib/server-cache";

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const data = await withCache(`onboarding:users:v${nsVersion("users")}`, 60_000, async () => {
      const { data, error } = await supabase
        .from("app_users")
        .select("email, role")
        .order("email", { ascending: true });
      if (error) throw new Error(error.message);
      return data ?? [];
    });
    return NextResponse.json(data);
  } catch (error) {
    console.error("[api/onboarding/users] GET failed:", error);
    return NextResponse.json({ error: "Failed to load users" }, { status: 500 });
  }
}
