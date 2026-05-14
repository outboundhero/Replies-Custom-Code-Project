import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "default-secret-change-me");
const COOKIE_NAME = "oh-session";

export type UserRole = "admin" | "inbox_manager";

interface SessionPayload {
  email: string;
  role: UserRole;
  /**
   * If set + non-empty, this user can ONLY see leads whose client_tag
   * is in this list. Enforced server-side in /api/inbox. Empty / null
   * means unrestricted (admins, plus inbox_managers with no scoping).
   */
  allowedClientTags?: string[] | null;
}

export async function createSession(
  email: string,
  role: UserRole,
  allowedClientTags?: string[] | null,
) {
  const token = await new SignJWT({ email, role, allowedClientTags: allowedClientTags ?? null })
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
    const raw = payload.allowedClientTags;
    const allowedClientTags = Array.isArray(raw)
      ? (raw.filter((t) => typeof t === "string" && t.trim()) as string[])
      : null;
    return {
      email: payload.email as string,
      role: payload.role as UserRole,
      allowedClientTags: allowedClientTags && allowedClientTags.length ? allowedClientTags : null,
    };
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
