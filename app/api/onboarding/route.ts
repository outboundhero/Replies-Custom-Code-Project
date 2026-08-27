/**
 * GET /api/onboarding — everything the onboarding page needs on first paint in a
 * SINGLE request: all onboarded clients (with done/total rollups), all tasks, and
 * the app-user list for the owner/assignee pickers. Board + users are cached under
 * their own namespaces (so each invalidates independently) but returned together
 * to cut the page's mount to one round-trip.
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { withCache, nsVersion } from "@/lib/server-cache";
import { listClients, listTasks } from "@/lib/onboarding/store";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const [board, users] = await Promise.all([
      withCache(`onboarding:board:v${nsVersion("onboarding")}`, 15_000, async () => {
        const [clients, tasks] = await Promise.all([listClients(), listTasks()]);
        return { clients, tasks };
      }),
      withCache(`onboarding:users:v${nsVersion("users")}`, 60_000, async () => {
        const { data, error } = await supabase.from("app_users").select("email, role").order("email", { ascending: true });
        if (error) throw new Error(error.message);
        return data ?? [];
      }),
    ]);
    return NextResponse.json({ ...board, users });
  } catch (error) {
    console.error("[api/onboarding] GET failed:", error);
    return NextResponse.json({ error: "Failed to load onboarding" }, { status: 500 });
  }
}
