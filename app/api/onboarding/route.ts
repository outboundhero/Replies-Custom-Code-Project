/**
 * GET /api/onboarding — everything the onboarding pages need on first paint in a
 * SINGLE request: all onboarded clients (with done/total rollups), all tasks,
 * the onboarding team (owners / assignees) and where the "Slack Outreachify"
 * step posts. Cached briefly; every write bumps the "onboarding" version.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { withCache, setCached, nsVersion } from "@/lib/server-cache";
import { listClients, listTasks, listOnboardingUsers, getSetting } from "@/lib/onboarding/store";
import { OUTREACHIFY_SLACK_SETTING, CAMPAIGN_MASTERS_SETTING, outreachifyDestinations } from "@/lib/onboarding/automations";
import { parseMasterSettings } from "@/lib/onboarding/campaign-plan";

async function loadBoard() {
  const [clients, tasks, users, slackSetting, slackDests, masters] = await Promise.all([
    listClients(), listTasks(), listOnboardingUsers(), getSetting(OUTREACHIFY_SLACK_SETTING), outreachifyDestinations(),
    getSetting(CAMPAIGN_MASTERS_SETTING),
  ]);
  return {
    clients, tasks, users,
    outreachifySlack: { saved: slackSetting, sendsTo: slackDests.map((d) => d.label) },
    campaignMasters: parseMasterSettings(masters),
  };
}

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
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
