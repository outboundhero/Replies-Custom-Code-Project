/**
 * POST/GET /api/auth/refresh
 *
 * Sliding-session renewal. If the caller still has a valid login cookie, re-issue
 * it with a fresh 7-day expiry. The inbox is a long-open single-page app that
 * rarely navigates, so without this an actively-working user's fixed 7-day token
 * expires mid-action (surfacing as a 401 "Unauthorized" on Send). The client
 * pings this on load, on tab focus, and periodically (see SessionKeepAlive) so an
 * active session never lapses. Idle (tab closed) sessions still expire normally.
 */
import { NextResponse } from "next/server";
import { getSession, createSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function handle() {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });
  // Re-sign the same identity with a fresh 7-day window + reset the cookie.
  await createSession(session.email, session.role, session.allowedClientTags);
  return NextResponse.json({ ok: true });
}

export const POST = handle;
export const GET = handle;
