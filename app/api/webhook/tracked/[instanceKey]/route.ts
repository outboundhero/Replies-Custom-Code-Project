/**
 * Per-instance tracked-reply webhook.
 *
 * URL: POST /api/webhook/tracked/<instanceKey>
 *
 * Bison points each instance's webhook at its own URL with the instance
 * key in the path. The handler validates the key, stamps it on every
 * row written by processTrackedReply, and rejects unknown keys with 404
 * so a misconfigured webhook can't silently land its rows under the
 * wrong instance.
 *
 * The legacy /api/webhook/tracked URL is a thin shim that calls this
 * handler with instanceKey="outboundhero" so existing Bison config
 * (the one we've had for months) keeps working untouched.
 */

import { NextRequest, NextResponse } from "next/server";
import { processTrackedReply } from "@/lib/processing/tracked";
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

    if (!payload?.data?.reply || !payload?.data?.campaign || !payload?.data?.lead) {
      return NextResponse.json(
        { error: "Missing required fields: data.{lead, reply, campaign}" },
        { status: 400 }
      );
    }

    await processTrackedReply(payload, instanceKey);
    return NextResponse.json({ ok: true, instance: instanceKey });
  } catch (error) {
    await logError("tracked", "webhook", (error as Error).message, {
      _webhook_payload: payload,
      bison_instance: instanceKey,
    });
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
