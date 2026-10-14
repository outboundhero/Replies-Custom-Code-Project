/**
 * GET  /api/onboarding/email-copy          — the copy in use for every client type + version lists
 * POST /api/onboarding/email-copy
 *   { action: "save",    type, steps, note?, baseVersion }  → a new version
 *   { action: "restore", type, version, baseVersion }        → an earlier version, saved again as the newest
 *   { action: "version", type, version }                     → one earlier version, to look at
 *
 * Admin-only, like the rest of onboarding. Saving changes the copy used for
 * campaigns created AFTERWARDS — no existing campaign is touched.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getSession } from "@/lib/auth";
import { isClientType, cleanSequence, LIMITS } from "@/lib/onboarding/copy-model";
import { readLibrary, readVersion, saveCopy, restoreCopy } from "@/lib/onboarding/copy-store";
import { logActivity } from "@/lib/errors";

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    return NextResponse.json({ ok: true, library: await readLibrary() });
  } catch (e) {
    console.error("[api/onboarding/email-copy] GET failed", e);
    return NextResponse.json({ ok: false, error: "Couldn't load the email copy." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const session = await getSession();
  const by = session?.email ?? null;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const type = body.type;
  if (!isClientType(type)) return NextResponse.json({ ok: false, error: "Unknown client type." }, { status: 400 });
  const baseVersion = body.baseVersion == null ? null : Number(body.baseVersion);
  if (baseVersion !== null && !Number.isInteger(baseVersion)) return NextResponse.json({ ok: false, error: "Bad baseVersion." }, { status: 400 });

  try {
    if (body.action === "version") {
      const v = await readVersion(type, Number(body.version));
      return v ? NextResponse.json({ ok: true, version: v }) : NextResponse.json({ ok: false, error: "No such version." }, { status: 404 });
    }
    if (body.action === "save") {
      if (Array.isArray(body.steps) && body.steps.length > LIMITS.maxSteps) {
        return NextResponse.json({ ok: false, reason: "invalid", error: `At most ${LIMITS.maxSteps} emails.` }, { status: 400 });
      }
      const seq = cleanSequence({ steps: body.steps });
      if (!seq) return NextResponse.json({ ok: false, error: "No emails sent." }, { status: 400 });
      const note = typeof body.note === "string" ? body.note : null;
      const r = await saveCopy(type, seq, by, note, baseVersion);
      if (!r.ok) return NextResponse.json({ ...r, error: r.reason === "invalid" ? r.errors.join(" ") : r.message }, { status: r.reason === "conflict" ? 409 : 400 });
      await logActivity("onboarding", "email-copy-saved", { details: { by, type, version: r.version.version, emails: seq.steps.length, note } }).catch(() => {});
      return NextResponse.json({ ok: true, version: r.version });
    }
    if (body.action === "restore") {
      const version = Number(body.version);
      if (!Number.isInteger(version)) return NextResponse.json({ ok: false, error: "Bad version." }, { status: 400 });
      const r = await restoreCopy(type, version, by, baseVersion);
      if (!r.ok) return NextResponse.json({ ...r, error: r.reason === "invalid" ? r.errors.join(" ") : r.message }, { status: r.reason === "conflict" ? 409 : 400 });
      await logActivity("onboarding", "email-copy-restored", { details: { by, type, from: version, version: r.version.version } }).catch(() => {});
      return NextResponse.json({ ok: true, version: r.version });
    }
    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (e) {
    console.error("[api/onboarding/email-copy] POST failed", e);
    return NextResponse.json({ ok: false, error: "Couldn't save the email copy — try again in a moment." }, { status: 500 });
  }
}
