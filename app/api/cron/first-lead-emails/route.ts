/**
 * GET /api/cron/first-lead-emails — every 10 minutes: retries a "First Set of Leads" email that
 * Gmail refused (up to 3 tries) and finishes a check that died part-way. A send that may already
 * have gone out is never retried here.
 */
import { NextRequest, NextResponse } from "next/server";
import { retryFirstLeadEmails } from "@/lib/first-lead-email";
import { logError } from "@/lib/errors";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const done = await retryFirstLeadEmails();
    for (const d of done) if (d.status === "failed") await logError("first-lead-email", "retry", `${d.tag}: still failing`).catch(() => undefined);
    return NextResponse.json({ ok: true, done });
  } catch (e) {
    await logError("first-lead-email", "retry", (e as Error).message).catch(() => undefined);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
