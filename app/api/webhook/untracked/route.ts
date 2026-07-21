/**
 * Legacy untracked-reply webhook URL — preserved so the original
 * outboundhero Bison config keeps working without reconfiguration.
 *
 * Functionally identical to /api/webhook/untracked/outboundhero.
 *
 * FAST-ACK: validate → return 200 → process in the background. See
 * /api/webhook/tracked/[instanceKey]/route.ts for the full rationale.
 */

import { after, NextRequest, NextResponse } from "next/server";
import { processUntrackedReply } from "@/lib/processing/untracked";
import { logError } from "@/lib/errors";
import { DEFAULT_INSTANCE } from "@/lib/bison-instances";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!payload?.data?.reply || !payload?.data?.sender_email) {
    return NextResponse.json(
      { error: "Missing required fields: data.{reply, sender_email}" },
      { status: 400 }
    );
  }

  after(async () => {
    try {
      await processUntrackedReply(payload, DEFAULT_INSTANCE);
    } catch (error) {
      await logError("untracked", "webhook", (error as Error).message, {
        _webhook_payload: payload,
        bison_instance: DEFAULT_INSTANCE,
      });
    }
  });

  return NextResponse.json({ ok: true, instance: DEFAULT_INSTANCE });
}
