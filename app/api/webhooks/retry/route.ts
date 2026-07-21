/**
 * POST /api/webhooks/retry   { instance, attemptId }
 *
 * Replays a single failed (or any) webhook attempt via Bison's
 * POST /api/webhook-attempts/{id}/retry. Bison re-sends the event to the
 * listener URL and returns a new webhook_delivery_id to track. Admin-only.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { isValidInstance } from "@/lib/bison-instances";
import { retryWebhookAttempt } from "@/lib/bison-webhooks";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { instance?: string; attemptId?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const instance = String(body.instance || "");
  const attemptId = Number(body.attemptId);
  if (!isValidInstance(instance)) {
    return NextResponse.json({ error: `Unknown instance: "${instance}"` }, { status: 400 });
  }
  if (!Number.isFinite(attemptId) || attemptId <= 0) {
    return NextResponse.json({ error: "attemptId is required" }, { status: 400 });
  }

  try {
    const result = await retryWebhookAttempt(instance, attemptId);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
