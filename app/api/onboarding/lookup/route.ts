/**
 * GET /api/onboarding/lookup?tag=CVJCIN — the client's row in the sheet's "New
 * Client Information" tab (company name, plan, start date), used to pre-fill the
 * Add-to-Onboarding form. The newest row wins when a tag appears more than once.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { fetchNewClientInfo } from "@/lib/google-sheets";
import { withCache } from "@/lib/server-cache";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const tag = (req.nextUrl.searchParams.get("tag") || "").trim().toUpperCase();
  if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });
  try {
    const rows = await withCache("onboarding:new-client-info", 60_000, fetchNewClientInfo);
    const hit = [...rows].reverse().find((r) => r.tags.includes(tag));
    if (!hit) return NextResponse.json({ found: false });
    return NextResponse.json({
      found: true,
      client_name: hit.companyName,
      plan: hit.plan,
      start_date: hit.startDate,
      contact_emails: hit.contactEmails,
      primary_contact_email: hit.primaryContactEmail,
    });
  } catch (e) {
    return NextResponse.json({ error: `Couldn't read the sheet: ${(e as Error).message}` }, { status: 502 });
  }
}
