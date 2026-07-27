/**
 * Lead-sheet push failures — dashboard API.
 *   GET                         → { pending: [...], count }
 *   POST { action, replyId }    → retry | dismiss a single failure
 *   POST { action: "retry-all" } → retry every pending failure
 *
 * Retry re-runs the exact same push; success auto-clears the row, failure keeps
 * it (with the new error + bumped attempt count).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { pushReplyToSheet } from "@/lib/push-reply-to-sheet";
import { listSheetPushFailures, dismissSheetPushFailure } from "@/lib/sheet-push-tracker";

export const maxDuration = 60;

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pending = await listSheetPushFailures("pending");
  return NextResponse.json({ pending, count: pending.length });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const action = String(body.action || "");

  if (action === "dismiss") {
    await dismissSheetPushFailure(Number(body.replyId));
    return NextResponse.json({ ok: true });
  }

  if (action === "retry") {
    const result = await pushReplyToSheet(Number(body.replyId));
    return NextResponse.json(result);
  }

  if (action === "retry-all") {
    const pending = await listSheetPushFailures("pending");
    let ok = 0, fail = 0;
    for (const f of pending) {
      const r = await pushReplyToSheet(f.reply_id);
      r.ok ? ok++ : fail++;
    }
    return NextResponse.json({ ok: true, retried: pending.length, succeeded: ok, failed: fail });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
