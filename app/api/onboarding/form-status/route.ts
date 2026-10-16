/**
 * GET /api/onboarding/form-status?tag=X[&fresh=1] — whether the client's Onboarding Form is in
 * (lib/onboarding/form-gate.ts), for the banner on its checklist and guided page. `fresh` reads the
 * sheet now ("Check again") and refreshes what the steps read too. Admin-only, read-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { onboardingFormGate } from "@/lib/onboarding/form-gate";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const tag = (req.nextUrl.searchParams.get("tag") || "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(tag)) return NextResponse.json({ error: "tag required" }, { status: 400 });
  const gate = await onboardingFormGate(tag, req.nextUrl.searchParams.get("fresh") === "1");
  return NextResponse.json({ ok: true, tag, state: gate.state, ready: gate.ready, message: gate.message });
}
