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
import db from "@/lib/db";
import { getTask, getClient, startRun, finishRun, assertTaskCanRun } from "@/lib/onboarding/store";
import { getAutomation, type RunOutcome } from "@/lib/onboarding/automations";
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
    if (!automation || !AUTOMATION_META[task.automation || ""]?.built) {
      return NextResponse.json({ error: "This step has no automation yet — complete it by hand." }, { status: 400 });
    }
    const client = await getClient(task.client_tag);
    if (!client) return NextResponse.json({ error: `${task.client_tag} isn't in onboarding.` }, { status: 404 });
    const session = await getSession();
    const ctx = { client, task, params, by: session?.email ?? null };

    const preview = await automation.preview(ctx);
    if (task.status === "completed") preview.blockers.unshift("This step is already Done. Reopen it first to run it again.");
    try { await assertTaskCanRun(task); } catch (e) { preview.blockers.unshift((e as Error).message); }
    if (mode === "preview") return NextResponse.json({ ok: true, preview });

    if (preview.blockers.length) return NextResponse.json({ error: preview.blockers.join(" "), preview }, { status: 409 });
    // One run at a time per task (a double-click must not send twice).
    const running = await db.execute({
      sql: "SELECT 1 FROM onboarding_task_run WHERE task_id = ? AND finished_at IS NULL AND started_at > ? LIMIT 1",
      args: [task.id, new Date(Date.now() - 5 * 60_000).toISOString()],
    });
    if (running.rows.length) return NextResponse.json({ error: "This step is already running." }, { status: 409 });

    const runId = await startRun(task, ctx.by, params);
    let outcome: RunOutcome;
    try { outcome = await automation.run(ctx); }
    catch (e) { outcome = { ok: false, summary: (e as Error).message }; }
    await finishRun(runId, task, ctx.by, outcome);
    if (outcome.ok) {
      await logActivity("onboarding", `run:${task.automation}`, { client_tag: task.client_tag, details: { by: ctx.by, task: task.title, summary: outcome.summary, result: outcome.result } });
    } else {
      await logError("onboarding", `run:${task.automation}`, outcome.summary, { client_tag: task.client_tag, by: ctx.by });
    }
    return NextResponse.json({ ok: outcome.ok, summary: outcome.summary, error: outcome.ok ? undefined : outcome.summary });
  } catch (e) {
    console.error("[api/onboarding/run]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
