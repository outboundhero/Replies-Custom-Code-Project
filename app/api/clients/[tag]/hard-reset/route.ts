/**
 * A client's Hard Reset or Nurture reset (admin only).
 *
 * GET  → the client's latest reset (either kind) with its progress
 * POST { action: "preview", kind?, params }            → what it would do (nothing changes)
 * POST { action: "start", kind?, params, confirm: TAG } → starts it (the preview is rebuilt fresh first; any blocker refuses)
 *      kind: "hard" (default — all 12 campaigns) or "nurture" (the 6 nurture campaigns + the queue re-opened)
 * POST { action: "retry", id }                   → a failed reset carries on from the step it stopped in
 * POST { action: "cancel", id }                  → before nurture is switched only: the new campaigns are deleted
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { normClientTag } from "@/lib/onboarding/copy-model";
import { logActivity } from "@/lib/errors";
import { previewReset, instanceName } from "@/lib/hard-reset/plan";
import { createReset, getReset, latestReset, patchReset, CANCELLABLE, type HardReset, type ResetKind } from "@/lib/hard-reset/store";
import { triggerHardResetRunner } from "@/lib/hard-reset/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function admin(raw: string): Promise<{ ok: true; tag: string; email: string | null } | { ok: false; res: NextResponse }> {
  const s = await getSession();
  if (!s) return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (s.role !== "admin") return { ok: false, res: NextResponse.json({ error: "Only admins can hard-reset a client." }, { status: 403 }) };
  let tag: string | null;
  try { tag = normClientTag(decodeURIComponent(raw)); } catch { tag = null; }
  if (!tag) return { ok: false, res: NextResponse.json({ error: "Bad client tag" }, { status: 400 }) };
  return { ok: true, tag, email: s.email ?? null };
}

/** Before nurture is switched (in a step that may be cancelled, or stopped in one). */
function cancellable(r: HardReset): boolean {
  if ((r.nurture?.after ?? []).length) return false;
  return CANCELLABLE.includes(r.status) || (r.status === "failed" && !!r.failedStep && CANCELLABLE.includes(r.failedStep));
}

/** What the page shows of a reset. */
function view(r: HardReset) {
  const created = r.built.filter((b) => b.state === "created" && b.campaignId != null);
  const failedBuild = [...r.built].reverse().find((b) => b.state === "failed");
  return {
    id: r.id, kind: r.kind, status: r.status, failedStep: r.failedStep, error: r.error, attempts: r.attempts,
    createdBy: r.createdBy, createdAt: r.createdAt, updatedAt: r.updatedAt, finishedAt: r.finishedAt,
    canCancel: cancellable(r),
    create: { done: created.length, total: r.kind === "nurture" ? 6 : 12, lastFailed: failedBuild && !failedBuild.cleared ? { name: failedBuild.name, note: failedBuild.note } : null },
    created: created.map((b) => ({ instance: b.instance, label: instanceName(b.instance), name: b.name, id: b.campaignId })),
    attach: [r.client.b2b, r.client.b2c].map((inst) => {
      const st = r.attach[inst];
      const camps = Object.values(st?.campaigns ?? {});
      return {
        instance: inst, label: instanceName(inst), inboxes: st?.senders?.length ?? null,
        verified: camps.filter((c) => c.verified).length, total: r.kind === "nurture" ? 3 : 6,
        refused: camps.reduce((n, c) => Math.max(n, c.refused.length), 0),
        notConnected: st?.offline?.length ?? 0, setAside: st?.setAside ?? 0,
      };
    }),
    nurture: { done: !!r.nurture?.after?.length, batchesCleared: r.nurture?.batches.length ?? 0, after: r.nurture?.after ?? [] },
    requeue: r.requeue ? {
      cleared: r.requeue.seq.cleared + r.requeue.replies.cleared + r.requeue.legacy.cleared,
      scanned: r.requeue.seq.scanned, done: !!r.requeue.ledgers && r.status !== "requeueing",
      recovered: r.requeue.ledgers?.recovered ?? null,
    } : null,
    archive: {
      total: r.archive.length,
      done: r.archived.length,
      rows: r.archive.map((c) => {
        const a = r.archived.find((x) => x.instance === c.instance && x.id === c.id);
        return { instance: c.instance, label: instanceName(c.instance), id: c.id, name: c.name, leads: c.leads, late: !!c.late, result: a?.result ?? null, note: a?.note ?? null };
      }),
    },
  };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ tag: string }> }) {
  const a = await admin((await params).tag);
  if (!a.ok) return a.res;
  try {
    const r = await latestReset(a.tag);
    return NextResponse.json({ ok: true, tag: a.tag, reset: r ? view(r) : null });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ tag: string }> }) {
  const a = await admin((await params).tag);
  if (!a.ok) return a.res;
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "");
  const p = (body?.params && typeof body.params === "object" ? body.params : {}) as Record<string, unknown>;
  const kind: ResetKind = body?.kind === "nurture" ? "nurture" : "hard";
  const log = (what: string, details: Record<string, unknown> = {}) => logActivity("hard-reset", what, { client_tag: a.tag, details: { by: a.email, ...details } });
  try {
    if (action === "preview") {
      const pr = await previewReset(a.tag, p, a.email, false, kind);
      return NextResponse.json({ ok: true, preview: { tag: pr.tag, inputs: pr.inputs, blockers: pr.blockers, tables: pr.tables, notes: pr.notes } });
    }

    if (action === "start") {
      if (String(body?.confirm ?? "").trim().toUpperCase() !== a.tag) return NextResponse.json({ error: `Type ${a.tag} to confirm.` }, { status: 400 });
      // Built again from fresh reads — never trusted from the preview on screen.
      const pr = await previewReset(a.tag, p, a.email, true, kind);
      if (pr.blockers.length || !pr.client || !pr.plan) return NextResponse.json({ error: pr.blockers.join(" ") || "The reset can't be planned right now.", blockers: pr.blockers }, { status: 409 });
      // The inputs it runs with are the ones the preview showed (the copy version is pinned among them).
      const pinned = Object.fromEntries(pr.inputs.map((i) => [i.key, i.value ?? ""]));
      let id: number;
      try {
        id = await createReset({ clientTag: a.tag, kind, params: pinned, client: pr.client, archive: pr.archive, by: a.email });
      } catch (e) {
        if (/UNIQUE/i.test((e as Error).message)) return NextResponse.json({ error: `A reset for ${a.tag} is already under way.` }, { status: 409 });
        throw e;
      }
      await log("started", { reset_id: id, kind, archive: pr.archive.map((c) => `${c.instance}:${c.id}`), group: pr.client.group });
      triggerHardResetRunner(id);
      return NextResponse.json({ ok: true, id });
    }

    const id = Number(body?.id);
    const r = Number.isInteger(id) ? await getReset(id) : null;
    if (!r || r.clientTag !== a.tag) return NextResponse.json({ error: "Reset not found" }, { status: 404 });

    if (action === "retry") {
      if (r.status !== "failed" || !r.failedStep) return NextResponse.json({ error: "Only a reset that stopped can be tried again." }, { status: 409 });
      if (!(await patchReset(id, { status: r.failedStep, failed_step: null, attempts: 0, error: null }, { from: ["failed"], failedStep: r.failedStep }))) return NextResponse.json({ error: "It changed meanwhile — reload." }, { status: 409 });
      await log("retried", { reset_id: id, step: r.failedStep });
      triggerHardResetRunner(id);
      return NextResponse.json({ ok: true });
    }

    if (action === "cancel") {
      if (!cancellable(r)) return NextResponse.json({ error: "It can't be cancelled now — nurture has been switched to the new campaigns. “Try again” finishes it." }, { status: 409 });
      // Only from exactly what was checked: a step that moved on meanwhile (or a different stop) refuses.
      const same = r.status === "failed" ? { from: ["failed" as const], failedStep: r.failedStep } : { from: [r.status] };
      if (!(await patchReset(id, { status: "cancelling", failed_step: null, attempts: 0, error: null }, same))) return NextResponse.json({ error: "It changed meanwhile — reload." }, { status: 409 });
      await log("cancelled", { reset_id: id, at_step: r.status === "failed" ? r.failedStep : r.status });
      triggerHardResetRunner(id);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown action “${action}”` }, { status: 400 });
  } catch (e) {
    console.error("[api/clients/hard-reset]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
