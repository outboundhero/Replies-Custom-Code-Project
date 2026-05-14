import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import supabase from "@/lib/supabase";
import bcrypt from "bcryptjs";

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const body = await req.json();
    const { action } = body;

    // --- CREATE USER ---
    if (action === "create") {
      const { email, password, role, allowedClientTags } = body;
      if (!email || !password || !role) {
        return NextResponse.json({ error: "Email, password, and role required" }, { status: 400 });
      }
      if (role !== "admin" && role !== "inbox_manager") {
        return NextResponse.json({ error: "Role must be admin or inbox_manager" }, { status: 400 });
      }

      const hash = await bcrypt.hash(password, 12);
      const tags = normalizeTags(allowedClientTags);

      const { error } = await supabase
        .from("app_users")
        .insert({
          email: email.toLowerCase().trim(),
          password_hash: hash,
          role,
          allowed_client_tags: tags,
        });

      if (error) {
        if (error.message.includes("duplicate")) {
          return NextResponse.json({ error: "User with this email already exists" }, { status: 409 });
        }
        throw new Error(error.message);
      }

      return NextResponse.json({ ok: true });
    }

    // --- UPDATE ALLOWED CLIENT TAGS ---
    if (action === "update-allowed-tags") {
      const { id, allowedClientTags } = body;
      if (!id) {
        return NextResponse.json({ error: "ID required" }, { status: 400 });
      }
      const tags = normalizeTags(allowedClientTags);
      const { error } = await supabase
        .from("app_users")
        .update({ allowed_client_tags: tags, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }

    // --- UPDATE ROLE ---
    if (action === "update-role") {
      const { id, role } = body;
      if (!id || !role) {
        return NextResponse.json({ error: "ID and role required" }, { status: 400 });
      }
      if (role !== "admin" && role !== "inbox_manager") {
        return NextResponse.json({ error: "Role must be admin or inbox_manager" }, { status: 400 });
      }

      const { error } = await supabase
        .from("app_users")
        .update({ role, updated_at: new Date().toISOString() })
        .eq("id", id);

      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }

    // --- RESET PASSWORD ---
    if (action === "reset-password") {
      const { id, password } = body;
      if (!id || !password) {
        return NextResponse.json({ error: "ID and password required" }, { status: 400 });
      }

      const hash = await bcrypt.hash(password, 12);

      const { error } = await supabase
        .from("app_users")
        .update({ password_hash: hash, updated_at: new Date().toISOString() })
        .eq("id", id);

      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }

    // --- DELETE USER ---
    if (action === "delete") {
      const { id } = body;
      if (!id) {
        return NextResponse.json({ error: "ID required" }, { status: 400 });
      }

      const { error } = await supabase
        .from("app_users")
        .delete()
        .eq("id", id);

      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("[api/users/mutate] POST failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

/**
 * Normalize a user-supplied list of client tags. Accepts:
 *   - undefined / null / "" → null (= unrestricted)
 *   - array of strings → trimmed, uppercased, deduped, empty entries dropped
 *   - comma/space-separated string → split and treated like an array
 * Empty result also returns null so the column stays nullable instead of [].
 */
function normalizeTags(input: unknown): string[] | null {
  if (input === undefined || input === null || input === "") return null;
  let arr: unknown[] = [];
  if (Array.isArray(input)) {
    arr = input;
  } else if (typeof input === "string") {
    arr = input.split(/[,\s]+/);
  } else {
    return null;
  }
  const cleaned = Array.from(
    new Set(
      arr
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  return cleaned.length ? cleaned : null;
}
