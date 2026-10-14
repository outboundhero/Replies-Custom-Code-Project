/**
 * GET  /api/onboarding/email-copy              — the copy in use for every client type + version lists,
 *                                                 and every client that has (or had) its own copy
 * GET  /api/onboarding/email-copy?client=TAG   — just that client's own copy (for its page), plus the
 *                                                 shared copies' version numbers
 * POST /api/onboarding/email-copy
 *   Shared copy of a client type:
 *   { action: "save",    type, steps, note?, baseVersion }  → a new version
 *   { action: "restore", type, version, baseVersion }        → an earlier version, saved again as the newest
 *   { action: "version", type, version }                     → one earlier version, to look at
 *   One client's own copy (`client` = its tag; it must be an onboarding client):
 *   { action: "save",       client, type, steps, note?, baseVersion, basedOn }
 *   { action: "restore",    client, version, baseVersion }
 *   { action: "version",    client, version }
 *   { action: "use-shared", client, baseVersion }           → back to the type's shared copy
 *   { action: "checked",    client, baseVersion }           → compared with the shared copy as it is now
 *
 * Admin-only, like the rest of onboarding. Saving changes the copy used for
 * campaigns created AFTERWARDS — no existing campaign is touched.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getSession } from "@/lib/auth";
import { isClientType, cleanSequence, normClientTag, LIMITS, CLIENT_TYPES } from "@/lib/onboarding/copy-model";
import {
  readLibrary, readVersion, saveCopy, restoreCopy,
  readClientCopies, readClientVersion, saveClientCopy, restoreClientCopy, switchToSharedCopy, markClientCopyChecked,
  type ClientSaveResult, type SaveResult,
} from "@/lib/onboarding/copy-store";
import { getClient, listClients } from "@/lib/onboarding/store";
import { logActivity } from "@/lib/errors";

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });
const refused = (r: Extract<SaveResult | ClientSaveResult, { ok: false }>) =>
  NextResponse.json({ ...r, error: r.reason === "invalid" ? r.errors.join(" ") : r.message }, { status: r.reason === "conflict" ? 409 : 400 });

export async function GET(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const one = req.nextUrl.searchParams.get("client");
    if (one !== null) {
      const tag = normClientTag(one);
      if (!tag) return bad("Bad client tag.");
      const [mine, library] = await Promise.all([readClientCopies(tag), readLibrary()]);
      return NextResponse.json({
        ok: true,
        client: mine[0] ?? null,
        shared: Object.fromEntries(library.map((e) => [e.type, e.current?.version ?? null])),
      });
    }
    const [library, clients, onboarding] = await Promise.all([readLibrary(), readClientCopies(), listClients()]);
    // Only clients still in onboarding — a removed client's copy is history, not something to edit.
    const current = new Set(onboarding.map((c) => c.client_tag.toUpperCase()));
    return NextResponse.json({ ok: true, library, clients: clients.filter((c) => current.has(c.tag)) });
  } catch (e) {
    console.error("[api/onboarding/email-copy] GET failed", e);
    return bad("Couldn't load the email copy.", 500);
  }
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const session = await getSession();
  const by = session?.email ?? null;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const baseVersion = body.baseVersion == null ? null : Number(body.baseVersion);
  if (baseVersion !== null && !Number.isInteger(baseVersion)) return bad("Bad baseVersion.");
  if (Array.isArray(body.steps) && body.steps.length > LIMITS.maxSteps) {
    return NextResponse.json({ ok: false, reason: "invalid", error: `At most ${LIMITS.maxSteps} emails.` }, { status: 400 });
  }

  try {
    if (body.client !== undefined) return await clientAction(body, by, baseVersion);

    const type = body.type;
    if (!isClientType(type)) return bad("Unknown client type.");
    if (body.action === "version") {
      const v = await readVersion(type, Number(body.version));
      return v ? NextResponse.json({ ok: true, version: v }) : bad("No such version.", 404);
    }
    if (body.action === "save") {
      const seq = cleanSequence({ steps: body.steps });
      if (!seq) return bad("No emails sent.");
      const note = typeof body.note === "string" ? body.note : null;
      const r = await saveCopy(type, seq, by, note, baseVersion);
      if (!r.ok) return refused(r);
      await logActivity("onboarding", "email-copy-saved", { details: { by, type, version: r.version.version, emails: seq.steps.length, note } }).catch(() => {});
      return NextResponse.json({ ok: true, version: r.version });
    }
    if (body.action === "restore") {
      const version = Number(body.version);
      if (!Number.isInteger(version)) return bad("Bad version.");
      const r = await restoreCopy(type, version, by, baseVersion);
      if (!r.ok) return refused(r);
      await logActivity("onboarding", "email-copy-restored", { details: { by, type, from: version, version: r.version.version } }).catch(() => {});
      return NextResponse.json({ ok: true, version: r.version });
    }
    return bad("Unknown action.");
  } catch (e) {
    console.error("[api/onboarding/email-copy] POST failed", e);
    return bad("Couldn't save the email copy — try again in a moment.", 500);
  }
}

async function clientAction(body: Record<string, unknown>, by: string | null, baseVersion: number | null) {
  const tag = normClientTag(body.client);
  if (!tag) return bad("Bad client tag.");
  // Only clients being onboarded — their campaigns are the ones built from this copy.
  if (!(await getClient(tag))) return bad(`${tag} isn't an onboarding client.`, 404);

  if (body.action === "version") {
    const v = await readClientVersion(tag, Number(body.version));
    return v ? NextResponse.json({ ok: true, version: v }) : bad("No such version.", 404);
  }

  let r: ClientSaveResult;
  if (body.action === "save") {
    const type = body.type;
    if (!isClientType(type)) return bad(`Say which shared copy this starts from (${CLIENT_TYPES.map((t) => t.key).join(", ")}).`);
    const seq = cleanSequence({ steps: body.steps });
    if (!seq) return bad("No emails sent.");
    const basedOn = body.basedOn == null ? null : Number(body.basedOn);
    if (basedOn !== null && !Number.isInteger(basedOn)) return bad("Bad basedOn.");
    r = await saveClientCopy(tag, type, seq, by, typeof body.note === "string" ? body.note : null, baseVersion, basedOn);
  } else if (body.action === "restore") {
    const version = Number(body.version);
    if (!Number.isInteger(version)) return bad("Bad version.");
    r = await restoreClientCopy(tag, version, by, baseVersion);
  } else if (body.action === "use-shared") {
    r = await switchToSharedCopy(tag, by, baseVersion);
  } else if (body.action === "checked") {
    r = await markClientCopyChecked(tag, by, baseVersion);
  } else {
    return bad("Unknown action.");
  }
  if (!r.ok) return refused(r);
  await logActivity("onboarding", `client-copy-${String(body.action)}`, {
    details: { by, client: tag, version: r.version.version, mode: r.version.mode, type: r.version.clientType, basedOn: r.version.basedOn },
  }).catch(() => {});
  return NextResponse.json({ ok: true, version: r.version });
}
