import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const { action, id } = await req.json();

    if (action === "delete") {
      if (id) {
        await db.execute({ sql: "DELETE FROM error_log WHERE id = ?", args: [id] });
      } else {
        await db.execute("DELETE FROM error_log");
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("[api/errors/mutate] POST failed:", error);
    return NextResponse.json({ error: "Failed to process request" }, { status: 500 });
  }
}
