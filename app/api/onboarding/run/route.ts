/**
 * POST /api/onboarding/run { taskId, mode: "preview" | "run", params }
 *
 * The checklist's Run button. `preview` returns exactly what the automation
 * would do (and why it can't yet, if so) without changing anything; `run` does
 * it, records the run, and marks the task Done on success. Admin-only —
 * automations act outside Reply Router (Slack, Email Bison, …).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getSession } from "@/lib/auth";
import { getTask, getClient, startRun, finishRun, releaseRun, assertTaskCanRun } from "@/lib/onboarding/store";
import { getAutomation, automationRunnable, type RunOutcome } from "@/lib/onboarding/automations";
import { AUTOMATION_META } from "@/lib/onboarding/ui";
import { logActivity, logError } from "@/lib/errors";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const taskId = String(body?.taskId || "");
  const mode = body?.mode === "run" ? "run" : "preview";
  const params = (body?.params && typeof body.params === "object" ? body.params : {}) as Record<string, unknown>;

  try {
    const task = await getTask(taskId);
    if (!task) return NextResponse.json({ error: "Task not found." }, { status: 404 });
    const automation = getAutomation(task.automation);
    const meta = AUTOMATION_META[task.automation || ""];
    // Built automations preview and run; preview-only ones can show what they
    // would do, and run only where their server switch is on.
    const runnable = automationRunnable(task.automation);
    if (!automation || !(runnable || (meta?.preview && mode === "preview"))) {
      return NextResponse.json({ error: "This step has no automation yet — complete it by hand." }, { status: 400 });
    }
    const client = await getClient(task.client_tag);
    if (!client) return NextResponse.json({ error: `${task.client_tag} isn't in onboarding.` }, { status: 404 });
    const session = await getSession();
    const ctx = { client, task, params, by: session?.email ?? null };

    const preview = await automation.preview(ctx);
    if (task.status === "completed") preview.blockers.unshift("This step is already Done. Reopen it first to run it again.");
    try { await assertTaskCanRun(task); } catch (e) { preview.blockers.unshift((e as Error).message); }
    if (mode === "preview") return NextResponse.json({ ok: true, preview, runnable });

    if (preview.blockers.length) return NextResponse.json({ error: preview.blockers.join(" "), preview }, { status: 409 });
    // One run at a time per task — the claim is atomic (a unique index), so a
    // double-click or two people can't both get past this line.
    const runId = await startRun(task, ctx.by, params);
    if (!runId) return NextResponse.json({ error: "This step is already running." }, { status: 409 });
    // Checked again now that the task is ours: a run that finished a moment
    // ago (between our first read and the claim) must not be repeated.
    const current = await getTask(task.id);
    if (!current || current.status === "completed") {
      await releaseRun(runId, "nothing to do — the step was already Done");
      return NextResponse.json({ error: "This step is already Done." }, { status: 409 });
    }

    let outcome: RunOutcome;
    try { outcome = await automation.run(ctx); }
    catch (e) { outcome = { ok: false, summary: (e as Error).message }; }
    // The automation has acted — recording that must not be lost to a blip.
    let saved = false;
    for (let attempt = 0; attempt < 3 && !saved; attempt++) {
      try { await finishRun(runId, task, ctx.by, outcome); saved = true; }
      catch (e) {
        console.error("[api/onboarding/run] saving the result failed", e);
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    if (!saved) {
      await logError("onboarding", `run:${task.automation}`, `result not saved: ${outcome.summary}`, { client_tag: task.client_tag, by: ctx.by });
      return NextResponse.json({
        ok: false,
        error: !outcome.ok ? outcome.summary
          : outcome.more ? "That part went through, but recording it failed. Open the preview before running again — it shows what is already done."
          : "It ran, but saving the result failed. Mark the step Done by hand — do not run it again.",
      }, { status: 500 });
    }
    if (outcome.ok) {
      await logActivity("onboarding", `run:${task.automation}`, { client_tag: task.client_tag, details: { by: ctx.by, task: task.title, summary: outcome.summary, result: outcome.result } });
    } else {
      await logError("onboarding", `run:${task.automation}`, outcome.summary, { client_tag: task.client_tag, by: ctx.by });
    }
    return NextResponse.json({ ok: outcome.ok, more: outcome.ok && !!outcome.more, summary: outcome.summary, error: outcome.ok ? undefined : outcome.summary });
  } catch (e) {
    console.error("[api/onboarding/run]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
