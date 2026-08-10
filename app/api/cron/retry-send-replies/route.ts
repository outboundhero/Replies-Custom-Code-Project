/**
 * GET /api/cron/retry-send-replies?secret=X
 *
 * Drains the auto-retry queue for reply sends that failed with an SMTP-auth
 * error: reconnects the inbox + re-attempts the send at +1h, then +2h
 * (lib/send-retry.ts). Scheduled every 15 min in vercel.json.
 */
import { NextRequest, NextResponse } from "next/server";
import { processSendRetries } from "@/lib/send-retry";
import { logError } from "@/lib/errors";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await processSendRetries();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    await logError("inbox", "retry-send-replies-cron", (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
