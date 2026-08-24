/**
 * POST /api/inbox/generate-reply  { id }
 *
 * Reply Router inbox "Generate Reply": resolves the client's reply template
 * (variables mapped) and then adapts it to the actual conversation (the lead's
 * message + full thread) — keeping the template's core. Returns the draft; does
 * NOT send. Two AI calls (resolve + generate), so its own longer maxDuration.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";
import db from "@/lib/db";
import { resolveTemplate } from "@/lib/processing/template-resolver";
import { generateReplyFromTemplate } from "@/lib/processing/generate-reply";
import { stripQuotedHistory } from "@/lib/qualification/strip-quoted";
import { buildConversationThread, threadToPrompt } from "@/lib/inbox/conversation-thread";
import { coerceInstance } from "@/lib/bison-instances";

export const maxDuration = 45;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id, instructions } = await req.json();
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

    const { data: r, error } = await supabase
      .from("replies")
      .select("client_tag, first_name, lead_name, company_name, phone, sender_name, reply_we_got, email_subject, reply_id, lead_id, campaign_id, bison_instance, lead_email, from_name")
      .eq("id", id)
      .single();
    if (error || !r) return NextResponse.json({ error: "Reply not found" }, { status: 404 });

    const allowed = session?.allowedClientTags ?? null;
    if (allowed?.length && (!r.client_tag || !allowed.includes(r.client_tag))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!r.client_tag || r.client_tag === "N/A") {
      return NextResponse.json({ ok: false, error: "This lead has no client tag, so there's no template to use." }, { status: 400 });
    }

    const cfg = await db.execute({ sql: "SELECT reply_template FROM client_config WHERE client_tag = ?", args: [r.client_tag] });
    const template = String(cfg.rows[0]?.reply_template || "").trim();
    if (!template) {
      return NextResponse.json({ ok: false, error: `No reply template is set for ${r.client_tag}. Add one in Clients first.` }, { status: 400 });
    }

    const leadMessage = stripQuotedHistory(String(r.reply_we_got || ""));
    const firstName = String(r.first_name || "").trim() || String(r.lead_name || "").trim().split(/\s+/)[0] || "";

    // 1. Resolve the template variables (name / company / phone / context).
    const resolved = await resolveTemplate(template, {
      firstName,
      phoneNumber: String(r.phone || ""),
      companyName: String(r.company_name || ""),
      senderFirstName: String(r.sender_name || "").trim().split(/\s+/)[0] || "",
      replyBody: leadMessage,
      replySubject: String(r.email_subject || ""),
      leadName: String(r.lead_name || ""),
      leadEmail: String(r.lead_email || ""),
      fromName: String(r.from_name || ""),
    });

    // 2. Build the full conversation (campaign email + follow-ups + replies) so
    //    the reply understands what was already said. Best-effort — falls back
    //    to the inbound reply text if the thread can't be fetched.
    let fullThread = String(r.reply_we_got || "");
    if (r.reply_id) {
      try {
        const entries = await buildConversationThread({
          instance: coerceInstance(r.bison_instance),
          replyId: Number(r.reply_id),
          leadId: r.lead_id ? Number(r.lead_id) : null,
          campaignId: r.campaign_id ? Number(r.campaign_id) : null,
          leadEmail: String(r.lead_email || ""),
        });
        if (entries.length) fullThread = threadToPrompt(entries);
      } catch { /* keep the reply-only fallback */ }
    }

    // 3. Adapt the resolved template to the conversation (core preserved).
    const result = await generateReplyFromTemplate({
      template: resolved,
      leadMessage,
      fullThread,
      instructions: typeof instructions === "string" ? instructions : "",
    });

    return NextResponse.json({ ok: result.ok, reply: result.reply, error: result.error });
  } catch (e) {
    console.error("[api/inbox/generate-reply] failed:", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
