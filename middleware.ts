import { NextRequest, NextResponse } from "next/server";
import { jwtVerify, SignJWT, type JWTPayload } from "jose";

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "default-secret-change-me");
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

/** Routes accessible by inbox_manager role */
const INBOX_MANAGER_ROUTES = ["/inbox", "/clients", "/qualification"];

/**
 * Sliding-session renew: re-sign the same identity with a fresh 7-day window and
 * attach it to the response, so an actively-navigating user's cookie never
 * lapses. (API routes are skipped by middleware, so the inbox SPA also pings
 * /api/auth/refresh — see SessionKeepAlive.)
 */
async function nextWithRenewedSession(payload: JWTPayload): Promise<NextResponse> {
  const res = NextResponse.next();
  try {
    const token = await new SignJWT({
      email: payload.email,
      role: payload.role,
      allowedClientTags: payload.allowedClientTags ?? null,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("7d")
      .sign(SECRET);
    res.cookies.set("oh-session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE,
      path: "/",
    });
  } catch {
    /* renew is best-effort — the existing valid cookie still works */
  }
  return res;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Skip auth for API routes, login, static assets
  if (
    pathname.startsWith("/api") ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get("oh-session")?.value;
  if (!token) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  try {
    const { payload } = await jwtVerify(token, SECRET);
    const role = payload.role as string;
    // Per-user client scoping. If non-empty, this user is restricted to
    // those tags AND we shrink their nav down to just the Inbox — no
    // Clients or Qualification (they have no business browsing the
    // broader system when they're locked to a single client).
    const rawTags = payload.allowedClientTags;
    const isScoped = Array.isArray(rawTags) && rawTags.length > 0;

    // Admin can access everything
    if (role === "admin") {
      return nextWithRenewedSession(payload);
    }

    // Inbox manager: restrict to allowed routes
    if (role === "inbox_manager") {
      // Root "/" always redirects inbox managers to /inbox
      if (pathname === "/") {
        return NextResponse.redirect(new URL("/inbox", req.url));
      }

      // Scoped users are inbox-only: anything outside /inbox bounces back.
      if (isScoped) {
        const isInbox = pathname === "/inbox" || pathname.startsWith("/inbox/");
        if (!isInbox) return NextResponse.redirect(new URL("/inbox", req.url));
        return nextWithRenewedSession(payload);
      }

      const allowed = INBOX_MANAGER_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"));
      if (!allowed) {
        return NextResponse.redirect(new URL("/inbox", req.url));
      }

      return nextWithRenewedSession(payload);
    }

    // Unknown role — redirect to login
    return NextResponse.redirect(new URL("/login", req.url));
  } catch {
    return NextResponse.redirect(new URL("/login", req.url));
  }
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
