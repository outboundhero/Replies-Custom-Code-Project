/**
 * POST /api/onboarding/mutate — all onboarding writes via an { action } dispatch.
 *
 * Admin-only:  add-client, delete-client, template-* (they change the roster /
 *              the shared template). Auth (any team member): task + client-status
 *              edits. Mirrors app/api/users/mutate/route.ts (guard → dispatch →
 *              bumpVersion handled inside the store helpers).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, getSession } from "@/lib/auth";
import {
  addOnboardingClient, updateClientStartDate, setClientStatus, deleteOnboardingClient, regenerateTasks,
  updateTaskStatus, updateTaskAssignee, updateTaskDueDate, addManualTask, deleteTask,
  upsertTemplateTask, deleteTemplateTask, reorderTemplate, seedDefaultTemplate,
} from "@/lib/onboarding/store";
import type { OnboardingRole, TaskStatus } from "@/lib/onboarding/generate";

const ADMIN_ACTIONS = new Set([
  "add-client", "delete-client",
  "template-upsert", "template-delete", "template-reorder", "template-seed",
]);

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { action } = body as { action?: string };
  if (!action) return NextResponse.json({ error: "action required" }, { status: 400 });

  // Guard: admin for roster/template changes, auth for the rest.
  const denied = ADMIN_ACTIONS.has(action) ? await requireAdmin() : await requireAuth();
  if (denied) return denied;

  try {
    switch (action) {
      // ── clients ──────────────────────────────────────────────
      case "add-client": {
        const session = await getSession();
        const res = await addOnboardingClient({
          client_tag: String(body.client_tag || ""),
          client_name: body.client_name ?? null,
          start_date: String(body.start_date || ""),
          domains_owner_email: body.domains_owner_email ?? null,
          inbox_owner_email: body.inbox_owner_email ?? null,
          ops_owner_email: body.ops_owner_email ?? null,
          created_by: session?.email ?? null,
        });
        return NextResponse.json({ ok: true, ...res });
      }
      case "update-start-date":
        await updateClientStartDate(String(body.client_tag || ""), String(body.start_date || ""));
        return NextResponse.json({ ok: true });
      case "set-client-status":
        await setClientStatus(String(body.client_tag || ""), body.status === "completed" ? "completed" : "active");
        return NextResponse.json({ ok: true });
      case "delete-client":
        await deleteOnboardingClient(String(body.client_tag || ""));
        return NextResponse.json({ ok: true });
      case "regenerate": {
        const n = await regenerateTasks(String(body.client_tag || ""));
        return NextResponse.json({ ok: true, added: n });
      }

      // ── tasks ────────────────────────────────────────────────
      case "update-task-status":
        await updateTaskStatus(String(body.id || ""), body.status as TaskStatus);
        return NextResponse.json({ ok: true });
      case "update-task-assignee":
        await updateTaskAssignee(String(body.id || ""), body.assignee_email ?? null);
        return NextResponse.json({ ok: true });
      case "update-task-due-date":
        await updateTaskDueDate(String(body.id || ""), String(body.due_date || ""));
        return NextResponse.json({ ok: true });
      case "add-task": {
        const id = await addManualTask({
          client_tag: String(body.client_tag || ""),
          title: String(body.title || ""),
          role: (body.role as OnboardingRole) || "ops",
          due_date: body.due_date ?? null,
          assignee_email: body.assignee_email ?? null,
          task_group: body.task_group ?? null,
        });
        return NextResponse.json({ ok: true, id });
      }
      case "delete-task":
        await deleteTask(String(body.id || ""));
        return NextResponse.json({ ok: true });

      // ── template ─────────────────────────────────────────────
      case "template-upsert": {
        const id = await upsertTemplateTask({
          id: body.id ?? null,
          title: String(body.title || ""),
          role: (body.role as OnboardingRole) || "ops",
          day_offset: Number(body.day_offset) || 0,
          task_group: body.task_group ?? null,
          order_index: body.order_index != null ? Number(body.order_index) : null,
        });
        return NextResponse.json({ ok: true, id });
      }
      case "template-delete":
        await deleteTemplateTask(String(body.id || ""));
        return NextResponse.json({ ok: true });
      case "template-reorder":
        await reorderTemplate(Array.isArray(body.orderedIds) ? body.orderedIds.map(String) : []);
        return NextResponse.json({ ok: true });
      case "template-seed": {
        const n = await seedDefaultTemplate();
        return NextResponse.json({ ok: true, seeded: n });
      }

      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
