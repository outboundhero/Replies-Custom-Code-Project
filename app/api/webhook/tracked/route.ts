/**
 * Legacy tracked-reply webhook URL — preserved so the original
 * outboundhero Bison config keeps working without reconfiguration.
 *
 * Functionally identical to /api/webhook/tracked/outboundhero. New
 * instances should point at /api/webhook/tracked/<instanceKey> instead.
 */

import { NextRequest, NextResponse } from "next/server";
import { processTrackedReply } from "@/lib/processing/tracked";
import { logError } from "@/lib/errors";
import { DEFAULT_INSTANCE } from "@/lib/bison-instances";

export async function POST(req: NextRequest) {
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

    await processTrackedReply(payload, DEFAULT_INSTANCE);
    return NextResponse.json({ ok: true, instance: DEFAULT_INSTANCE });
  } catch (error) {
    await logError("tracked", "webhook", (error as Error).message, {
      _webhook_payload: payload,
      bison_instance: DEFAULT_INSTANCE,
    });
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
