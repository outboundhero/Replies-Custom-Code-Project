/**
 * GET /api/onboarding/users — lightweight app-user list (email + role) for the
 * owner/assignee pickers. Auth-only (unlike GET /api/users which is admin-only),
 * because any team member needs the list to reassign a task.
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { withCache, nsVersion } from "@/lib/server-cache";

export async function GET() {
  const denied = await requireAuth();
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
