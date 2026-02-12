import { NextRequest, NextResponse } from "next/server";
import { processUntrackedReply } from "@/lib/processing/untracked";
import { logError } from "@/lib/errors";

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();

    // Validate required fields
    if (!payload?.data?.reply || !payload?.data?.sender_email) {
      return NextResponse.json(
        { error: "Missing required fields: data.{reply, sender_email}" },
        { status: 400 }
      );
    }

    await processUntrackedReply(payload);
    return NextResponse.json({ ok: true });
  } catch (error) {
    await logError("untracked", "webhook", (error as Error).message);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
