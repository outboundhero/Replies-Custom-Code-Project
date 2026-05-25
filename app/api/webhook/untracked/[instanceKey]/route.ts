/**
 * Per-instance untracked-reply webhook.
 *
 * URL: POST /api/webhook/untracked/<instanceKey>
 *
 * Same shape as the tracked variant — see that file's header for why.
 */

import { NextRequest, NextResponse } from "next/server";
import { processUntrackedReply } from "@/lib/processing/untracked";
import { logError } from "@/lib/errors";
import { isValidInstance } from "@/lib/bison-instances";

export async function POST(req: NextRequest, { params }: { params: Promise<{ instanceKey: string }> }) {
  const { instanceKey } = await params;

  if (!isValidInstance(instanceKey)) {
    return NextResponse.json({ error: `Unknown Bison instance: ${instanceKey}` }, { status: 404 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any;
  try {
    payload = await req.json();

    if (!payload?.data?.reply || !payload?.data?.sender_email) {
      return NextResponse.json(
        { error: "Missing required fields: data.{reply, sender_email}" },
        { status: 400 }
      );
    }

    await processUntrackedReply(payload, instanceKey);
    return NextResponse.json({ ok: true, instance: instanceKey });
  } catch (error) {
    await logError("untracked", "webhook", (error as Error).message, {
      _webhook_payload: payload,
      bison_instance: instanceKey,
    });
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
