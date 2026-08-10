import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { bumpVersion } from "@/lib/server-cache";
import supabase from "@/lib/supabase";
import { CC_BCC_CATEGORIES } from "@/lib/processing/lead-categorizer";
import { bumpCacheVersion } from "@/lib/inbox-cache";

const CONFIG_KEYS = [
  "cc_name_1", "cc_email_1", "cc_name_2", "cc_email_2", "cc_name_3", "cc_email_3",
  "cc_name_4", "cc_email_4", "cc_name_5", "cc_email_5", "cc_name_6", "cc_email_6",
  "bcc_name_1", "bcc_email_1", "bcc_name_2", "bcc_email_2", "reply_template",
] as const;

const nn = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s ? s : null;
};

/** Upsert a client's CC/BCC + reply template into client_config (Turso). */
async function upsertClientConfig(body: Record<string, unknown>): Promise<void> {
  await db.execute({
    sql: `INSERT INTO client_config
            (client_tag, cc_name_1, cc_email_1, cc_name_2, cc_email_2,
             cc_name_3, cc_email_3, cc_name_4, cc_email_4,
             cc_name_5, cc_email_5, cc_name_6, cc_email_6,
             bcc_name_1, bcc_email_1, bcc_name_2, bcc_email_2,
             reply_template, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(client_tag) DO UPDATE SET
            cc_name_1 = excluded.cc_name_1, cc_email_1 = excluded.cc_email_1,
            cc_name_2 = excluded.cc_name_2, cc_email_2 = excluded.cc_email_2,
            cc_name_3 = excluded.cc_name_3, cc_email_3 = excluded.cc_email_3,
            cc_name_4 = excluded.cc_name_4, cc_email_4 = excluded.cc_email_4,
            cc_name_5 = excluded.cc_name_5, cc_email_5 = excluded.cc_email_5,
            cc_name_6 = excluded.cc_name_6, cc_email_6 = excluded.cc_email_6,
            bcc_name_1 = excluded.bcc_name_1, bcc_email_1 = excluded.bcc_email_1,
            bcc_name_2 = excluded.bcc_name_2, bcc_email_2 = excluded.bcc_email_2,
            reply_template = excluded.reply_template,
            updated_at = CURRENT_TIMESTAMP`,
    args: [String(body.tag).trim(), ...CONFIG_KEYS.map((k) => nn(body[k]))],
  });
}

// POST /api/config/clients/mutate — all mutations via { action: "create" | "update" | "delete" }
export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  bumpVersion("config");
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
      if (!body.tag) {
        return NextResponse.json({ error: "tag required" }, { status: 400 });
      }
      await upsertClientConfig(body);
      return NextResponse.json({ ok: true });
    }

    // ── force-upsert-template ───────────────────────────────
    // Backfill the client's CURRENT reply template + CC/BCC onto EXISTING leads
    // that would have received them at ingest but didn't (template configured
    // late): replies with lead_category "Open Response" AND a positive AI
    // category (CC_BCC_CATEGORIES — the ones templates auto-apply for).
    //   preview:true → return the affected count without writing.
    //   otherwise    → save the config, then overwrite those replies' our_reply
    //                  + CC/BCC from it. Mirrors exactly what ingest writes.
    if (action === "force-upsert-template") {
      const tag = body.tag ? String(body.tag).trim() : "";
      if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });

      const scoped = () =>
        supabase
          .from("replies")
          .select("id", { count: "exact", head: true })
          .eq("client_tag", tag)
          .eq("lead_category", "Open Response")
          .in("ai_categorized_lead_category", CC_BCC_CATEGORIES as unknown as string[]);

      if (body.preview) {
        const { count, error } = await scoped();
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true, count: count ?? 0 });
      }

      // 1. Persist the config so it's the single source of truth going forward.
      await upsertClientConfig(body);

      // 2. Overwrite matching existing replies with the same fields ingest sets.
      const fields: Record<string, string | null> = {
        our_reply: nn(body.reply_template),
        cc_name_1: nn(body.cc_name_1), cc_email_1: nn(body.cc_email_1),
        cc_name_2: nn(body.cc_name_2), cc_email_2: nn(body.cc_email_2),
        cc_name_3: nn(body.cc_name_3), cc_email_3: nn(body.cc_email_3),
        cc_name_4: nn(body.cc_name_4), cc_email_4: nn(body.cc_email_4),
        cc_name_5: nn(body.cc_name_5), cc_email_5: nn(body.cc_email_5),
        cc_name_6: nn(body.cc_name_6), cc_email_6: nn(body.cc_email_6),
        bcc_name_1: nn(body.bcc_name_1), bcc_email_1: nn(body.bcc_email_1),
        bcc_name_2: nn(body.bcc_name_2), bcc_email_2: nn(body.bcc_email_2),
      };
      const { data, error } = await supabase
        .from("replies")
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq("client_tag", tag)
        .eq("lead_category", "Open Response")
        .in("ai_categorized_lead_category", CC_BCC_CATEGORIES as unknown as string[])
        .select("id");
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      bumpCacheVersion(); // inbox reflects the new templates on next load
      return NextResponse.json({ ok: true, updated: data?.length ?? 0 });
    }

    // ── move ────────────────────────────────────────────────
    // Reassign a client tag to a different section. Affects routing of
    // FUTURE leads only — historical replies stay attached to whatever
    // Airtable base they were originally created in.
    if (action === "move") {
      const { tag, section_id } = body;
      if (!tag || !section_id) {
        return NextResponse.json({ error: "tag and section_id required" }, { status: 400 });
      }

      const result = await db.execute({
        sql: "UPDATE client_tags SET section_id = ? WHERE tag = ?",
        args: [section_id, tag],
      });
      if (result.rowsAffected === 0) {
        return NextResponse.json({ error: `Client tag "${tag}" not found` }, { status: 404 });
      }

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
