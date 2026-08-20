import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";
import db from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Leads whose reply/handoff send FAILED and could not auto-recover (the retry
 * queue exhausted its reconnect attempts) and are still unresolved. Powers the
 * "needs manual intervention" strip at the top of the inbox. Scoped to the
 * caller's allowed client tags.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const rows = await db.execute({
      sql: `SELECT reply_row_id, to_email, client_tag, sender_email, last_error, updated_at
            FROM send_reply_retries
            WHERE status = 'exhausted'
            ORDER BY updated_at DESC
            LIMIT 100`,
      args: [],
    });

    const allowed = session.allowedClientTags ?? null;
    const scoped = rows.rows.filter((r) => {
      if (!allowed || !allowed.length) return true;
      return r.client_tag != null && allowed.includes(String(r.client_tag));
    });
    if (!scoped.length) return NextResponse.json({ items: [] });

    // Only surface rows that are STILL failed — a manual resend clears send_error,
    // so an exhausted retry whose lead has since been sent should drop off.
    const ids = scoped.map((r) => Number(r.reply_row_id)).filter((n) => Number.isFinite(n));
    const { data: replies } = await supabase
      .from("replies")
      .select("id, send_error")
      .in("id", ids);
    const stillFailed = new Set(
      (replies || []).filter((r) => r.send_error).map((r) => Number(r.id)),
    );

    const items = scoped
      .filter((r) => stillFailed.has(Number(r.reply_row_id)))
      .map((r) => ({
        replyId: Number(r.reply_row_id),
        leadEmail: String(r.to_email ?? ""),
        clientTag: r.client_tag != null ? String(r.client_tag) : null,
        senderEmail: r.sender_email != null ? String(r.sender_email) : null,
        lastError: r.last_error != null ? String(r.last_error) : null,
        at: r.updated_at != null ? String(r.updated_at) : null,
      }));

    return NextResponse.json({ items });
  } catch (error) {
    // Never break the inbox over this — just show nothing.
    console.error("[api/inbox/needs-attention] failed:", error);
    return NextResponse.json({ items: [] });
  }
}
