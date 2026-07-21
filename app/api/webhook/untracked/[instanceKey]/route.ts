/**
 * Per-instance untracked-reply webhook.
 *
 * URL: POST /api/webhook/untracked/<instanceKey>
 *
 * Same shape as the tracked variant — see that file's header for why,
 * including the FAST-ACK rationale (validate → 200 → process in the
 * background via `after()`).
 */

import { after, NextRequest, NextResponse } from "next/server";
import { processUntrackedReply } from "@/lib/processing/untracked";
import { logError } from "@/lib/errors";
import { isValidInstance } from "@/lib/bison-instances";

// Headroom for the deferred pipeline; the response itself returns in ms.
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ instanceKey: string }> }) {
  const { instanceKey } = await params;

  if (!isValidInstance(instanceKey)) {
    return NextResponse.json({ error: `Unknown Bison instance: ${instanceKey}` }, { status: 404 });
  }

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

  // ACK Bison now; process after the response is flushed.
  after(async () => {
    try {
      await processUntrackedReply(payload, instanceKey);
    } catch (error) {
      await logError("untracked", "webhook", (error as Error).message, {
        _webhook_payload: payload,
        bison_instance: instanceKey,
      });
    }
  });

  return NextResponse.json({ ok: true, instance: instanceKey });
}
