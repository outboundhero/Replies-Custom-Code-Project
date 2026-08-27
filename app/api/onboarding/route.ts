/**
 * GET /api/onboarding — everything the onboarding page needs on first paint in a
 * SINGLE request: all onboarded clients (with done/total rollups), all tasks, and
 * the app-user list for the owner/assignee pickers. Board + users are cached under
 * their own namespaces (so each invalidates independently) but returned together
 * to cut the page's mount to one round-trip.
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { withCache, nsVersion } from "@/lib/server-cache";
import { listClients, listTasks, listOnboardingUsers } from "@/lib/onboarding/store";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const data = await withCache(`onboarding:board:v${nsVersion("onboarding")}`, 15_000, async () => {
      const [clients, tasks, users] = await Promise.all([listClients(), listTasks(), listOnboardingUsers()]);
      return { clients, tasks, users };
    });
    return NextResponse.json(data);
  } catch (error) {
    console.error("[api/onboarding] GET failed:", error);
    return NextResponse.json({ error: "Failed to load onboarding" }, { status: 500 });
  }
}
