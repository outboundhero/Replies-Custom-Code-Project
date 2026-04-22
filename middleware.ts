import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "default-secret-change-me");

/** Routes accessible by inbox_manager role */
const INBOX_MANAGER_ROUTES = ["/inbox", "/clients"];

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

    // Admin can access everything
    if (role === "admin") {
      return NextResponse.next();
    }

    // Inbox manager: restrict to allowed routes
    if (role === "inbox_manager") {
      const allowed = INBOX_MANAGER_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"));

      // Root "/" redirects to /inbox for inbox managers
      if (pathname === "/") {
        return NextResponse.redirect(new URL("/inbox", req.url));
      }

      if (!allowed) {
        return NextResponse.redirect(new URL("/inbox", req.url));
      }

      return NextResponse.next();
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
