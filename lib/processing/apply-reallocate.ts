import supabase from "@/lib/supabase";
import db from "@/lib/db";
import { resolveTemplate } from "@/lib/processing/template-resolver";
import { bumpCacheVersion } from "@/lib/inbox-cache";

/**
 * Move a replies row to a different client tag and rewrite its CC/BCC + reply
 * template fields to match the new tag's client_config. Used by both the
 * manual Reallocate button in the inbox and the CW ZIP auto-router.
 *
 * Mirrors the exact field set the inbox handler used to write inline, so the
 * two paths can never drift apart.
 */
export async function applyReallocate(
  rowId: number,
  newClientTag: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const configResult = await db.execute({
    sql: "SELECT * FROM client_config WHERE client_tag = ?",
    args: [newClientTag],
  });
  const cfg = configResult.rows[0];

  const updateData: Record<string, unknown> = {
    client_tag: newClientTag,
    updated_at: new Date().toISOString(),
  };

  if (cfg) {
    updateData.cc_name_1 = cfg.cc_name_1 ? String(cfg.cc_name_1) : null;
    updateData.cc_email_1 = cfg.cc_email_1 ? String(cfg.cc_email_1) : null;
    updateData.cc_name_2 = cfg.cc_name_2 ? String(cfg.cc_name_2) : null;
    updateData.cc_email_2 = cfg.cc_email_2 ? String(cfg.cc_email_2) : null;
    updateData.cc_name_3 = cfg.cc_name_3 ? String(cfg.cc_name_3) : null;
    updateData.cc_email_3 = cfg.cc_email_3 ? String(cfg.cc_email_3) : null;
    updateData.cc_name_4 = cfg.cc_name_4 ? String(cfg.cc_name_4) : null;
    updateData.cc_email_4 = cfg.cc_email_4 ? String(cfg.cc_email_4) : null;
    updateData.cc_name_5 = cfg.cc_name_5 ? String(cfg.cc_name_5) : null;
    updateData.cc_email_5 = cfg.cc_email_5 ? String(cfg.cc_email_5) : null;
    updateData.cc_name_6 = cfg.cc_name_6 ? String(cfg.cc_name_6) : null;
    updateData.cc_email_6 = cfg.cc_email_6 ? String(cfg.cc_email_6) : null;
    updateData.bcc_name_1 = cfg.bcc_name_1 ? String(cfg.bcc_name_1) : null;
    updateData.bcc_email_1 = cfg.bcc_email_1 ? String(cfg.bcc_email_1) : null;
    updateData.bcc_name_2 = cfg.bcc_name_2 ? String(cfg.bcc_name_2) : null;
    updateData.bcc_email_2 = cfg.bcc_email_2 ? String(cfg.bcc_email_2) : null;

    if (cfg.reply_template) {
      const { data: leadRow } = await supabase
        .from("replies")
        .select("first_name, lead_name, phone, company_name, sender_name, reply_we_got, email_subject")
        .eq("id", rowId)
        .single();
      const firstName =
        ((leadRow?.first_name as string | null) || "").trim()
        || ((leadRow?.lead_name as string | null) || "").trim().split(/\s+/)[0]
        || "";
      const senderFirstName =
        ((leadRow?.sender_name as string | null) || "").trim().split(/\s+/)[0] || "";
      try {
        updateData.our_reply = await resolveTemplate(String(cfg.reply_template), {
          firstName: firstName || "",
          phoneNumber: String(leadRow?.phone || ""),
          companyName: String(leadRow?.company_name || ""),
          senderFirstName,
          replyBody: String(leadRow?.reply_we_got || ""),
          replySubject: String(leadRow?.email_subject || ""),
        });
      } catch (e) {
        console.warn("[applyReallocate] template resolve failed, using raw template:", (e as Error).message);
        updateData.our_reply = String(cfg.reply_template);
      }
    } else {
      updateData.our_reply = null;
    }
  }

  const { error } = await supabase.from("replies").update(updateData).eq("id", rowId);
  if (error) return { ok: false, error: error.message };
  bumpCacheVersion();
  return { ok: true };
}
