import { NextRequest, NextResponse } from "next/server";
import { createSession, clearSession } from "@/lib/auth";

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

    // --- LOGIN (default) ---
    const { password } = body;

    if (password !== process.env.ADMIN_PASSWORD) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    await createSession();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[auth] Login failed:", error);
    return NextResponse.json({ error: "Authentication failed" }, { status: 500 });
  }
}
