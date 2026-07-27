/**
 * GET /api/cron/keep-warm — keeps the hot serverless functions warm so the
 * team never pays a cold-start tax on a section change.
 *
 * The app bundles heavy deps (googleapis, supabase, libsql, openai), so a cold
 * Next.js function can take several seconds to boot. When the team clicks
 * through sections every minute or two, functions go cold between clicks and
 * every navigation eats that boot time (~5-6s observed). Pinging the main
 * routes every few minutes keeps them warm — and, because we ping them with a
 * valid session, it also re-populates each route's server-side response cache,
 * so the real page load is served warm.
 *
 * Runs every 5 minutes. Auth: CRON_SECRET.
 */
import { NextRequest, NextResponse } from "next/server";
import { SignJWT } from "jose";

export const maxDuration = 60;

const ROUTES = [
  "/api/config/clients",
  "/api/config/sections",
  "/api/config/qualification",
  "/api/config/untracked",
  "/api/users",
  "/api/inbox?mode=bootstrap&view=base-clients-cherry",
  "/api/data-view?sort=created_at.desc&limit=50&offset=0",
  "/api/sheet-pushes",
];

function baseUrl(): string {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "replies-custom-code-project.vercel.app";
  return host.startsWith("http") ? host : `https://${host}`;
}

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Mint a short-lived admin session so the warmed requests run fully (and thus
  // refill each route's server cache), not just bounce off the auth check.
  const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "default-secret-change-me");
  const token = await new SignJWT({ email: "keep-warm@internal", role: "admin", allowedClientTags: null })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(SECRET);
  const cookie = `oh-session=${token}`;
  const base = baseUrl();

  // Vercel serves the team from a few concurrent function instances, so warm
  // several per route (concurrent requests force Vercel to spin up / keep warm
  // multiple instances) — otherwise a user can still land on a cold one.
  const FANOUT = 3;
  const hit = async (path: string) => {
    const t0 = Date.now();
    try {
      const r = await fetch(base + path, { headers: { cookie }, signal: AbortSignal.timeout(25000) });
      await r.text().catch(() => "");
      return { path, ms: Date.now() - t0, status: r.status };
    } catch (e) {
      return { path, ms: Date.now() - t0, error: (e as Error).message };
    }
  };
  const results = await Promise.all(
    ROUTES.flatMap((path) => Array.from({ length: FANOUT }, () => hit(path))),
  );

  return NextResponse.json({ ok: true, base, fanout: FANOUT, warmed: results.length });
}
