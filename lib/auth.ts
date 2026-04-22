import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "default-secret-change-me");
const COOKIE_NAME = "oh-session";

export type UserRole = "admin" | "inbox_manager";

interface SessionPayload {
  email: string;
  role: UserRole;
}

export async function createSession(email: string, role: UserRole) {
  const token = await new SignJWT({ email, role })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .sign(SECRET);

  (await cookies()).set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });
}

export async function verifySession(): Promise<boolean> {
  try {
    const token = (await cookies()).get(COOKIE_NAME)?.value;
    if (!token) return false;
    await jwtVerify(token, SECRET);
    return true;
  } catch {
    return false;
  }
}

/** Get the current user's session data (email + role) */
export async function getSession(): Promise<SessionPayload | null> {
  try {
    const token = (await cookies()).get(COOKIE_NAME)?.value;
    if (!token) return null;
    const { payload } = await jwtVerify(token, SECRET);
    return { email: payload.email as string, role: payload.role as UserRole };
  } catch {
    return null;
  }
}

export async function clearSession() {
  (await cookies()).delete(COOKIE_NAME);
}

/** Check auth from an API route. Returns a 401 Response if not authenticated, or null if OK. */
export async function requireAuth(): Promise<Response | null> {
  const valid = await verifySession();
  if (!valid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/** Check auth + require admin role. Returns a 403 Response if not admin. */
export async function requireAdmin(): Promise<Response | null> {
  const session = await getSession();
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.role !== "admin") {
    return Response.json({ error: "Forbidden — admin only" }, { status: 403 });
  }
  return null;
}
