import { NextRequest, NextResponse } from "next/server";
import { processTrackedReply } from "@/lib/processing/tracked";
import { logError } from "@/lib/errors";

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();

    // Validate required fields
    if (!payload?.data?.reply || !payload?.data?.campaign || !payload?.data?.lead) {
      return NextResponse.json(
        { error: "Missing required fields: data.{lead, reply, campaign}" },
        { status: 400 }
      );
    }

    await processTrackedReply(payload);
    return NextResponse.json({ ok: true });
  } catch (error) {
    await logError("tracked", "webhook", (error as Error).message);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
