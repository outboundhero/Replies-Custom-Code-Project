/**
 * POST /api/inbox/reconnect-inbox  { id }
 *
 * Reconnect the sending inbox behind a reply whose send failed with an SMTP
 * auth error ("Please re-connect this email account"). Looks up the reply's
 * sender_email + bison_instance server-side (not trusting the client) and
 * re-uploads it to Inboxing (see lib/inboxing-upload.ts). The reconnect is a
 * queued job — the operator retries the send once it completes.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { reconnectInbox } from "@/lib/inboxing-upload";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const id = Number(body?.id);
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { data, error } = await supabase
    .from("replies")
    .select("sender_email, bison_instance, client_tag")
    .eq("id", id)
    .single();
  if (error || !data) return NextResponse.json({ error: "reply not found" }, { status: 404 });

  // Respect per-user client scoping.
  if (
    session.allowedClientTags?.length &&
    !session.allowedClientTags.includes(String(data.client_tag || ""))
  ) {
    return NextResponse.json({ error: "not allowed for this client" }, { status: 403 });
  }

  const result = await reconnectInbox(String(data.sender_email || ""), String(data.bison_instance || ""));
  return NextResponse.json(result, { status: result.ok ? 200 : result.status || 400 });
}
