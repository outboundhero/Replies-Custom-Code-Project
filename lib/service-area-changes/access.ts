/**
 * Who can work service-area changes: the same people as the client page —
 * admins and inbox managers who aren't limited to certain clients. Anyone of
 * them can approve (no second person needed).
 */
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { normClientTag } from "@/lib/onboarding/copy-model";

/** The team check without a client (lists across clients). */
export async function teamSession(): Promise<{ ok: true; email: string | null } | { ok: false; res: NextResponse }> {
  const session = await getSession();
  if (!session) return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if ((session.allowedClientTags && session.allowedClientTags.length) || (session.role !== "admin" && session.role !== "inbox_manager")) {
    return { ok: false, res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true, email: session.email ?? null };
}

export async function teamAccess(rawTag: string): Promise<{ ok: true; tag: string; email: string | null } | { ok: false; res: NextResponse }> {
  const t = await teamSession();
  if (!t.ok) return t;
  let tag: string | null;
  try { tag = normClientTag(decodeURIComponent(rawTag)); } catch { tag = null; }
  if (!tag) return { ok: false, res: NextResponse.json({ error: "Bad client tag" }, { status: 400 }) };
  return { ok: true, tag, email: t.email };
}
