/**
 * GET /api/client-sheet?tag=CLIENTTAG → { sheet_url: string | null }
 *
 * The client's Google-Sheet URL, split out of the reply-detail fetch so a cold
 * external-registry call never blocks the inbox detail from rendering. Called
 * lazily by the inbox after the detail is already on screen; the client caches
 * it per tag so switching between a client's leads never refetches.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getSheetForClient } from "@/lib/google-sheets-registry";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tag = (req.nextUrl.searchParams.get("tag") || "").trim();
  if (!tag || tag === "N/A") return NextResponse.json({ sheet_url: null });

  try {
    const sheet = await getSheetForClient(tag);
    const sheet_url = sheet?.id ? `https://docs.google.com/spreadsheets/d/${sheet.id}` : null;
    return NextResponse.json({ sheet_url });
  } catch {
    return NextResponse.json({ sheet_url: null });
  }
}
