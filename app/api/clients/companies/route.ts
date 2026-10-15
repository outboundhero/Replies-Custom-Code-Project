/**
 * GET /api/clients/companies — { TAG: company name } from the Client Tracker, for
 * the Clients list (loaded after the list itself so the list stays fast).
 * Same access as the Clients page: admins and unscoped inbox managers.
 */
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { withCache } from "@/lib/server-cache";
import { fetchClientTrackerRecords } from "@/lib/google-sheets";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((session.allowedClientTags && session.allowedClientTags.length) || (session.role !== "admin" && session.role !== "inbox_manager")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const tracker = await withCache("profile:tracker", 60_000, fetchClientTrackerRecords);
    const companies: Record<string, string> = {};
    for (const [tag, rec] of tracker) if (rec.company) companies[tag] = rec.company;
    return NextResponse.json({ ok: true, companies });
  } catch (e) {
    console.error("[api/clients/companies]", e);
    return NextResponse.json({ ok: false, companies: {} }, { status: 200 });
  }
}
