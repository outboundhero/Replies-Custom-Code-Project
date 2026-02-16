import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { processTrackedReply } from "@/lib/processing/tracked";
import { processUntrackedReply } from "@/lib/processing/untracked";
import { sendToClayWebhook } from "@/lib/clay";

export async function POST(req: NextRequest) {
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
