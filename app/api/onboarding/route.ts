/**
 * GET /api/onboarding — everything the onboarding pages need on first paint in a
 * SINGLE request: all onboarded clients (with done/total rollups), all tasks,
 * the onboarding team (owners / assignees) and where the "Slack Outreachify"
 * step posts. Cached briefly; every write bumps the "onboarding" version.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { withCache, setCached, nsVersion } from "@/lib/server-cache";
import { listClients, listTasks, listOnboardingUsers, getSetting, upgradeTemplate } from "@/lib/onboarding/store";
import { OUTREACHIFY_SLACK_SETTING, outreachifyDestinations, automationRunnable, automationStates } from "@/lib/onboarding/automations";

async function loadBoard() {
  await upgradeTemplate().catch((e) => console.error("[api/onboarding] template upgrade failed", e));
  const [clients, tasks, users, slackSetting, slackDests] = await Promise.all([
    listClients(), listTasks(), listOnboardingUsers(), getSetting(OUTREACHIFY_SLACK_SETTING), outreachifyDestinations(),
  ]);
  return {
    clients, users,
    // Whether each step's automation can be run on this server right now, so
    // the row offers Run (not just Preview) where its switch is on.
    tasks: tasks.map((task) => (task.automation ? { ...task, runnable: automationRunnable(task.automation) } : task)),
    outreachifySlack: { saved: slackSetting, sendsTo: slackDests.map((d) => d.label) },
    // Each automation's live state (its switch), for the Template tab's labels.
    automationStates: automationStates(),
  };
}

export async function GET(req: NextRequest) {
  // Admin-only, like the page (middleware keeps everyone else off /onboarding).
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const key = `onboarding:board:v${nsVersion("onboarding")}`;
    // ?fresh=1 — the page reloading right after its own write. The cache is per
    // warm instance, so the instance answering this may not have seen the
    // write's version bump: read the database, then refresh the cache.
    if (req.nextUrl.searchParams.get("fresh") === "1") {
      const data = await loadBoard();
      setCached(key, data);
      return NextResponse.json(data);
    }
    const data = await withCache(key, 15_000, loadBoard);
    return NextResponse.json(data);
  } catch (error) {
    console.error("[api/onboarding] GET failed:", error);
    return NextResponse.json({ error: "Failed to load onboarding" }, { status: 500 });
  }
}
