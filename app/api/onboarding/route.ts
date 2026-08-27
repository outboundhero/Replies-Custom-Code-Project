/**
 * GET /api/onboarding — the onboarding board data: all onboarded clients (with
 * done/total rollups) + all tasks. Enough for the All-Clients table, the status
 * board, and client-side "My Tasks" filtering. Cached by the onboarding cache ns.
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { withCache, nsVersion } from "@/lib/server-cache";
import { listClients, listTasks } from "@/lib/onboarding/store";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const data = await withCache(`onboarding:board:v${nsVersion("onboarding")}`, 15_000, async () => {
      const [clients, tasks] = await Promise.all([listClients(), listTasks()]);
      return { clients, tasks };
    });
    return NextResponse.json(data);
  } catch (error) {
    console.error("[api/onboarding] GET failed:", error);
    return NextResponse.json({ error: "Failed to load onboarding" }, { status: 500 });
  }
}
