import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";

// POST /api/config/clients/mutate — all mutations via { action: "create" | "update" | "delete" }
export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  try {
    const body = await req.json();
    const { action } = body;

    // ── create ──────────────────────────────────────────────
    if (action === "create") {
      const { tag, section_id } = body;
      if (!tag || !section_id) {
        return NextResponse.json({ error: "tag and section_id required" }, { status: 400 });
      }

      await db.execute({
        sql: "INSERT INTO client_tags (tag, section_id) VALUES (?, ?)",
        args: [tag.trim(), section_id],
      });

      await db.execute({
        sql: "INSERT OR IGNORE INTO client_config (client_tag) VALUES (?)",
        args: [tag.trim()],
      });

      return NextResponse.json({ ok: true });
    }

    // ── update ──────────────────────────────────────────────
    if (action === "update") {
      const {
        tag,
        cc_name_1, cc_email_1,
        cc_name_2, cc_email_2,
        cc_name_3, cc_email_3,
        cc_name_4, cc_email_4,
        cc_name_5, cc_email_5,
        cc_name_6, cc_email_6,
        bcc_name_1, bcc_email_1,
        bcc_name_2, bcc_email_2,
        reply_template,
      } = body;

      if (!tag) {
        return NextResponse.json({ error: "tag required" }, { status: 400 });
      }

      await db.execute({
        sql: `INSERT INTO client_config
                (client_tag, cc_name_1, cc_email_1, cc_name_2, cc_email_2,
                 cc_name_3, cc_email_3, cc_name_4, cc_email_4,
                 cc_name_5, cc_email_5, cc_name_6, cc_email_6,
                 bcc_name_1, bcc_email_1, bcc_name_2, bcc_email_2,
                 reply_template, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(client_tag) DO UPDATE SET
                cc_name_1 = excluded.cc_name_1,
                cc_email_1 = excluded.cc_email_1,
                cc_name_2 = excluded.cc_name_2,
                cc_email_2 = excluded.cc_email_2,
                cc_name_3 = excluded.cc_name_3,
                cc_email_3 = excluded.cc_email_3,
                cc_name_4 = excluded.cc_name_4,
                cc_email_4 = excluded.cc_email_4,
                cc_name_5 = excluded.cc_name_5,
                cc_email_5 = excluded.cc_email_5,
                cc_name_6 = excluded.cc_name_6,
                cc_email_6 = excluded.cc_email_6,
                bcc_name_1 = excluded.bcc_name_1,
                bcc_email_1 = excluded.bcc_email_1,
                bcc_name_2 = excluded.bcc_name_2,
                bcc_email_2 = excluded.bcc_email_2,
                reply_template = excluded.reply_template,
                updated_at = CURRENT_TIMESTAMP`,
        args: [
          tag,
          cc_name_1 || null, cc_email_1 || null,
          cc_name_2 || null, cc_email_2 || null,
          cc_name_3 || null, cc_email_3 || null,
          cc_name_4 || null, cc_email_4 || null,
          cc_name_5 || null, cc_email_5 || null,
          cc_name_6 || null, cc_email_6 || null,
          bcc_name_1 || null, bcc_email_1 || null,
          bcc_name_2 || null, bcc_email_2 || null,
          reply_template || null,
        ],
      });

      return NextResponse.json({ ok: true });
    }

    // ── delete ──────────────────────────────────────────────
    if (action === "delete") {
      const { tag } = body;
      if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });

      await db.execute({ sql: "DELETE FROM client_tags WHERE tag = ?", args: [tag] });
      await db.execute({ sql: "DELETE FROM client_config WHERE client_tag = ?", args: [tag] });

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("[api/config/clients/mutate] POST failed:", error);
    return NextResponse.json({ error: "Failed to process request" }, { status: 500 });
  }
}
