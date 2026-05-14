import { NextRequest, NextResponse } from "next/server";
import { createSession, clearSession, getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";
import bcrypt from "bcryptjs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    // --- LOGOUT ---
    if (action === "logout") {
      try {
        await clearSession();
        return NextResponse.json({ ok: true });
      } catch (error) {
        console.error("[auth] Logout failed:", error);
        return NextResponse.json({ error: "Logout failed" }, { status: 500 });
      }
    }

    // --- GET SESSION (for client to know role) ---
    if (action === "session") {
      const session = await getSession();
      if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
      return NextResponse.json({
        email: session.email,
        role: session.role,
        allowedClientTags: session.allowedClientTags ?? null,
      });
    }

    // --- LOGIN ---
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password required" }, { status: 400 });
    }

    // Look up user in Supabase
    const { data: user, error: dbError } = await supabase
      .from("app_users")
      .select("email, password_hash, role, allowed_client_tags")
      .eq("email", email.toLowerCase().trim())
      .single();

    if (dbError || !user) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }

    const allowedClientTags = Array.isArray(user.allowed_client_tags)
      ? (user.allowed_client_tags as string[]).filter((t) => typeof t === "string" && t.trim())
      : null;

    await createSession(user.email, user.role, allowedClientTags);
    return NextResponse.json({ ok: true, role: user.role });
  } catch (error) {
    console.error("[auth] Login failed:", error);
    return NextResponse.json({ error: "Authentication failed" }, { status: 500 });
  }
}
