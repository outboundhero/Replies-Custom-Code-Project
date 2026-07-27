/**
 * GET /api/cron/retry-sheet-pushes — auto-retry pending lead-sheet push
 * failures so transient Google API blips self-heal without anyone touching the
 * dashboard. A row that succeeds is cleared; one that keeps failing stays
 * visible for manual retry / dismiss. Runs every 15 minutes.
 *
 * Auth: CRON_SECRET (Bearer / x-cron-secret / ?secret).
 */
import { NextRequest, NextResponse } from "next/server";
import { pushReplyToSheet } from "@/lib/push-reply-to-sheet";
import { listSheetPushFailures } from "@/lib/sheet-push-tracker";
import { logActivity } from "@/lib/errors";

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pending = await listSheetPushFailures("pending");
  let ok = 0, fail = 0;
  for (const f of pending) {
    const r = await pushReplyToSheet(f.reply_id);
    r.ok ? ok++ : fail++;
  }
  if (pending.length) await logActivity("sheet-push-retry", "run", { details: { pending: pending.length, succeeded: ok, failed: fail } });
  return NextResponse.json({ ok: true, pending: pending.length, succeeded: ok, failed: fail });
}
