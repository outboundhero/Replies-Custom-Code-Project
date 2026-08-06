import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import supabase from "@/lib/supabase";
import { requireAuth } from "@/lib/auth";
import { processTrackedReply } from "@/lib/processing/tracked";
import { processUntrackedReply } from "@/lib/processing/untracked";
import { sendToClayWebhook } from "@/lib/clay";
import { blacklistDomain, blacklistEmail } from "@/lib/processing/domain-blacklist";
import { coerceInstance } from "@/lib/bison-instances";
import { sendReply } from "@/lib/outboundhero-api";

export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;
  const { id } = await req.json();

  if (!id) {
    return NextResponse.json({ error: "Missing error id" }, { status: 400 });
  }

  // Find the error entry with payload
  const result = await db.execute({
    sql: "SELECT * FROM error_log WHERE id = ?",
    args: [id],
  });

  const entry = result.rows[0];
  if (!entry) {
    return NextResponse.json({ error: "Error entry not found" }, { status: 404 });
  }

  const stage = entry.stage as string;
  const entryPayload = entry.payload as string | null;

  // ── Blacklist API errors (domain or email) ──
  // Payload format from lib/processing/domain-blacklist.ts:
  //   stage "blacklist"        → { domain, from_email, matched_phrase }
  //   stage "email-blacklist"  → { email }
  // Re-call the blacklist function, which is idempotent (422 "already taken"
  // is treated as success). Clears the error on a clean call.
  if ((stage === "blacklist" || stage === "email-blacklist") && entryPayload) {
    try {
      const parsed = JSON.parse(entryPayload);
      try {
        // Pre-multi-instance error rows didn't store bison_instance; fall
        // back to the default. New rows carry it explicitly.
        const retryInstance = coerceInstance(parsed.bison_instance);
        if (stage === "blacklist") {
          if (!parsed.from_email) throw new Error("Missing from_email in payload");
          await blacklistDomain(
            retryInstance,
            parsed.from_email,
            parsed.matched_phrase || "",
            (entry.workflow as string) || "tracked"
          );
        } else {
          if (!parsed.email) throw new Error("Missing email in payload");
          await blacklistEmail(retryInstance, parsed.email, (entry.workflow as string) || "tracked");
        }
        // The blacklist function logs its own error if it fails again, so we
        // verify by checking whether a fresh error row was just written.
        const fresh = await db.execute({
          sql: `SELECT id FROM error_log
                WHERE stage = ? AND timestamp > datetime('now', '-10 seconds')
                ORDER BY id DESC LIMIT 1`,
          args: [stage],
        });
        if (fresh.rows.length > 0) {
          return NextResponse.json(
            { error: "Blacklist API still failing — check logs" },
            { status: 502 }
          );
        }
        await db.execute({ sql: "DELETE FROM error_log WHERE id = ?", args: [id] });
        return NextResponse.json({ ok: true, message: "Blacklist retry successful" });
      } catch (error) {
        return NextResponse.json(
          { error: `Blacklist retry failed: ${(error as Error).message}` },
          { status: 500 }
        );
      }
    } catch {
      return NextResponse.json(
        { error: "Stored blacklist payload is malformed JSON" },
        { status: 400 }
      );
    }
  }

  // ── Inbox send-reply errors — re-send the stored draft to the same recipients.
  // These fail transiently (e.g. "Sending disabled due to billing over-use"); once
  // the block clears, Retry / Retry All actually pushes the reply out. The draft +
  // recipients live on the last reply_sends row for this reply. ──
  if ((entry.workflow as string) === "inbox" && stage === "send-reply" && entryPayload) {
    try {
      const p = JSON.parse(entryPayload) as { row_id?: number; instance?: string; client_tag?: string };
      const replyRowId = Number(p.row_id);
      if (!replyRowId) throw new Error("no row_id stored on this error");

      const { data: reply } = await supabase
        .from("replies")
        .select("reply_id, sender_id, bison_instance, lead_email, lead_name, email_subject, lead_id, client_tag")
        .eq("id", replyRowId).single();
      if (!reply) throw new Error("reply not found");

      const { data: sends } = await supabase
        .from("reply_sends")
        .select("message, to_json, cc_json, bcc_json, status")
        .eq("reply_row_id", replyRowId).order("id", { ascending: false }).limit(1);
      const last = sends?.[0] as { message?: string; to_json?: Array<{ name?: string; email?: string }>; cc_json?: unknown; bcc_json?: unknown; status?: string } | undefined;

      // Already sent since this error (e.g. a manual resend) → just clear it.
      if (last?.status === "sent") {
        await db.execute({ sql: "DELETE FROM error_log WHERE id = ?", args: [id] });
        return NextResponse.json({ ok: true, message: "Already sent — cleared stale error" });
      }

      const message = String(last?.message || "").trim();
      if (!message) throw new Error("no stored draft to re-send");
      const toEmail = last?.to_json?.[0]?.email || (reply.lead_email as string) || "";
      const toName = last?.to_json?.[0]?.name || (reply.lead_name as string) || "";
      const toRecipients = (v: unknown) => Array.isArray(v)
        ? (v as Array<{ name?: string; email_address?: string }>)
            .map((c) => ({ name: c.name || "", email_address: c.email_address || "" }))
            .filter((c) => c.email_address)
        : undefined;
      const ccEmails = toRecipients(last?.cc_json);
      const bccEmails = toRecipients(last?.bcc_json);
      const instance = coerceInstance((reply.bison_instance as string) || p.instance);

      const result = await sendReply(instance, {
        replyId: Number(reply.reply_id), senderEmailId: Number(reply.sender_id),
        message, toEmail, toName, ccEmails, bccEmails,
        subject: (reply.email_subject as string) || undefined,
        leadId: reply.lead_id ? Number(reply.lead_id) : undefined,
      });
      if (!result.ok) {
        return NextResponse.json({ error: `Send still failing: ${result.error}` }, { status: 502 });
      }

      const nowIso = new Date().toISOString();
      await supabase.from("replies").update({ sent_reply: message, last_sent_at: nowIso, send_error: null, send_error_at: null, updated_at: nowIso }).eq("id", replyRowId);
      try {
        await supabase.from("reply_sends").insert({
          reply_row_id: replyRowId, client_tag: reply.client_tag ?? null, lead_email: toEmail || null,
          message, to_json: toEmail ? [{ name: toName, email: toEmail }] : null,
          cc_json: ccEmails ?? null, bcc_json: bccEmails ?? null, status: "sent", error: null,
        });
      } catch { /* history is best-effort */ }
      await db.execute({ sql: "DELETE FROM error_log WHERE id = ?", args: [id] });
      return NextResponse.json({ ok: true, message: "Reply re-sent" });
    } catch (error) {
      return NextResponse.json({ error: `Send retry failed: ${(error as Error).message}` }, { status: 500 });
    }
  }

  // Check if this is a Clay error with retry data
  if (stage === "clay" && entryPayload) {
    try {
      const parsed = JSON.parse(entryPayload);
      if (parsed._clay_retry_data) {
        const { webhook_url, data } = parsed._clay_retry_data;
        try {
          await sendToClayWebhook(webhook_url, data);
          await db.execute({
            sql: "DELETE FROM error_log WHERE id = ?",
            args: [id],
          });
          return NextResponse.json({ ok: true, message: "Clay retry successful" });
        } catch (error) {
          return NextResponse.json(
            { error: `Clay retry failed: ${(error as Error).message}` },
            { status: 500 }
          );
        }
      }
    } catch {
      // not valid JSON or no retry data
    }
  }

  // Webhook-level retry (full pipeline replay)
  let payload: unknown = null;

  if (entryPayload) {
    try {
      const parsed = JSON.parse(entryPayload);
      if (parsed._webhook_payload) {
        payload = parsed._webhook_payload;
      }
    } catch {
      // not valid JSON
    }
  }

  // If no payload on this entry, look for the webhook-stage sibling.
  // ±5s was too tight under load — the webhook-stage error logs after
  // the throw bubbles up, which can take many seconds for late-stage
  // failures (Airtable retries internally, Clay timeouts, etc.).
  // ±5 minutes covers the slowest realistic failure path.
  if (!payload) {
    const siblings = await db.execute({
      sql: `SELECT payload FROM error_log
            WHERE workflow = ? AND stage = 'webhook' AND payload IS NOT NULL
            AND timestamp >= datetime(?, '-5 minutes') AND timestamp <= datetime(?, '+5 minutes')
            ORDER BY ABS(strftime('%s', timestamp) - strftime('%s', ?)) ASC LIMIT 1`,
      args: [entry.workflow as string, entry.timestamp as string, entry.timestamp as string, entry.timestamp as string],
    });

    if (siblings.rows[0]?.payload) {
      try {
        const parsed = JSON.parse(siblings.rows[0].payload as string);
        if (parsed._webhook_payload) {
          payload = parsed._webhook_payload;
        }
      } catch {
        // not valid JSON
      }
    }
  }

  if (!payload) {
    return NextResponse.json(
      { error: "No retry data found. Only webhook or Clay errors with stored payloads can be retried." },
      { status: 400 }
    );
  }

  // Retry the processing
  try {
    const workflow = entry.workflow as string;
    if (workflow === "tracked") {
      await processTrackedReply(payload as Parameters<typeof processTrackedReply>[0]);
    } else if (workflow === "untracked") {
      await processUntrackedReply(payload as Parameters<typeof processUntrackedReply>[0]);
    } else {
      return NextResponse.json({ error: `Unknown workflow: ${workflow}` }, { status: 400 });
    }

    // Success — delete the error entry
    await db.execute({
      sql: "DELETE FROM error_log WHERE id = ?",
      args: [id],
    });

    return NextResponse.json({ ok: true, message: "Retry successful" });
  } catch (error) {
    return NextResponse.json(
      { error: `Retry failed: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}
