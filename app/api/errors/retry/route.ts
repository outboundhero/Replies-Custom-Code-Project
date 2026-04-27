import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { processTrackedReply } from "@/lib/processing/tracked";
import { processUntrackedReply } from "@/lib/processing/untracked";
import { sendToClayWebhook } from "@/lib/clay";
import { blacklistDomain, blacklistEmail } from "@/lib/processing/domain-blacklist";

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
        if (stage === "blacklist") {
          if (!parsed.from_email) throw new Error("Missing from_email in payload");
          await blacklistDomain(
            parsed.from_email,
            parsed.matched_phrase || "",
            (entry.workflow as string) || "tracked"
          );
        } else {
          if (!parsed.email) throw new Error("Missing email in payload");
          await blacklistEmail(parsed.email, (entry.workflow as string) || "tracked");
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

  // If no payload on this entry, look for the webhook-stage sibling
  if (!payload) {
    const siblings = await db.execute({
      sql: `SELECT payload FROM error_log
            WHERE workflow = ? AND stage = 'webhook' AND payload IS NOT NULL
            AND timestamp >= datetime(?, '-5 seconds') AND timestamp <= datetime(?, '+5 seconds')
            ORDER BY id DESC LIMIT 1`,
      args: [entry.workflow as string, entry.timestamp as string, entry.timestamp as string],
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
