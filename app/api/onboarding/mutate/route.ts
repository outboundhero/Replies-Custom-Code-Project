/**
 * POST /api/onboarding/mutate — all onboarding writes via an { action } dispatch.
 *
 * Admin-only:  add-client, delete-client, template-* (they change the roster /
 *              the shared template). Auth (any team member): task + client-status
 *              edits. Mirrors app/api/users/mutate/route.ts (guard → dispatch →
 *              bumpVersion handled inside the store helpers).
 */
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { requireAuth, requireAdmin, getSession } from "@/lib/auth";
import {
  addOnboardingClient, updateClientStartDate, setClientStatus, deleteOnboardingClient, regenerateTasks,
  updateTaskStatus, updateTaskAssignee, updateTaskDueDate, addManualTask, deleteTask,
  bulkUpdateTaskStatus, listTasks, getTask,
  upsertTemplateTask, deleteTemplateTask, reorderTemplate, seedDefaultTemplate,
  upsertOnboardingUser, deleteOnboardingUser,
} from "@/lib/onboarding/store";
import { notifyOwnersOnAdd, notifyAssignee } from "@/lib/onboarding/notify";
import type { OnboardingRole, TaskStatus } from "@/lib/onboarding/generate";

const ADMIN_ACTIONS = new Set([
  "add-client", "delete-client",
  "template-upsert", "template-delete", "template-reorder", "template-seed",
  "user-upsert", "user-delete",
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
          plan_type: body.plan_type ?? null,
          start_date: String(body.start_date || ""),
          domains_owner_email: body.domains_owner_email ?? null,
          inbox_owner_email: body.inbox_owner_email ?? null,
          ops_owner_email: body.ops_owner_email ?? null,
          created_by: session?.email ?? null,
        });
        // DM each owner a summary of their new tasks. after() keeps the function
        // alive past the response so the Slack calls actually complete on serverless.
        if (res.tasks > 0) {
          after(async () => {
            const tasks = await listTasks({ tag: res.client_tag });
            await notifyOwnersOnAdd(res.client_tag, body.client_name ?? null, tasks);
          });
        }
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
      case "update-task-assignee": {
        const email = body.assignee_email ?? null;
        await updateTaskAssignee(String(body.id || ""), email);
        // Ping the new assignee about this task; after() so the DM completes.
        if (email) {
          after(async () => {
            const t = await getTask(String(body.id || ""));
            if (t) await notifyAssignee(email, t.client_tag, t.title, t.due_date);
          });
        }
        return NextResponse.json({ ok: true });
      }
      case "bulk-task-status": {
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        const n = await bulkUpdateTaskStatus(ids, body.status as TaskStatus);
        return NextResponse.json({ ok: true, updated: n });
      }
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

      // ── onboarding users (Slack member IDs) ──────────────────
      case "user-upsert": {
        const id = await upsertOnboardingUser({
          id: body.id ?? null,
          name: String(body.name || ""),
          slack_member_id: body.slack_member_id ?? null,
        });
        return NextResponse.json({ ok: true, id });
      }
      case "user-delete":
        await deleteOnboardingUser(String(body.id || ""));
        return NextResponse.json({ ok: true });

      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
