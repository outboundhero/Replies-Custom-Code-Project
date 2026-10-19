/**
 * The "First Set of Leads" email for one client (lib/first-lead-email). Admin-only.
 *   GET  ?tag=X                         its record + whether sending to clients is switched on
 *   POST { action: "test", tag, to }    the exact email, sent only to a test address
 *   POST { action: "send", tag }        send it now for real (switch must be on; never twice)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getSession } from "@/lib/auth";
import { alreadyHadLeads, getFirstLeadRecord, sendFirstLeadNow, sendFirstLeadTest, sendingSwitchedOn } from "@/lib/first-lead-email";
import { TEST_RECIPIENTS } from "@/lib/gmail-send";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TAG = /^[A-Z0-9][A-Z0-9&_-]{0,39}$/;

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const tag = (req.nextUrl.searchParams.get("tag") || "").trim().toUpperCase();
  if (!TAG.test(tag)) return NextResponse.json({ error: "tag required" }, { status: 400 });
  const record = await getFirstLeadRecord(tag);
  // Nothing recorded yet: say whether the client already had leads (then it never gets this email).
  const hadLeads = record ? null : await alreadyHadLeads(tag).catch(() => null);
  return NextResponse.json({ ok: true, record, hadLeads, switchedOn: sendingSwitchedOn(), testRecipients: TEST_RECIPIENTS });
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as { action?: string; tag?: string; to?: string } | null;
  const tag = String(b?.tag || "").trim().toUpperCase();
  if (!TAG.test(tag)) return NextResponse.json({ ok: false, error: "tag required" }, { status: 400 });
  try {
    if (b?.action === "test") {
      const to = String(b.to || "").trim().toLowerCase();
      if (!TEST_RECIPIENTS.includes(to)) return NextResponse.json({ ok: false, error: `Tests go only to ${TEST_RECIPIENTS.join(" or ")}.` }, { status: 400 });
      return NextResponse.json({ ok: true, ...(await sendFirstLeadTest(tag, to)) });
    }
    if (b?.action === "send") {
      const who = (await getSession())?.email ?? "admin";
      return NextResponse.json({ ok: true, record: await sendFirstLeadNow(tag, who) });
    }
    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
