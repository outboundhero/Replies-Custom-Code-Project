/**
 * POST /api/onboarding/mutate — all onboarding writes via an { action } dispatch.
 *
 * Admin-only:  add-client, delete-client, set-client-group, template-*, user-*,
 *              setting-set (they change the roster, the shared template or
 *              where automations post). Auth (any team member): task +
 *              client-status edits. Mirrors app/api/users/mutate/route.ts
 *              (guard → dispatch → bumpVersion handled inside the store helpers).
 */
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { requireAuth, requireAdmin, getSession } from "@/lib/auth";
import {
  addOnboardingClient, updateClientStartDate, setClientStatus, setClientGroup, deleteOnboardingClient, regenerateTasks,
  updateTaskStatus, updateTaskAssignee, updateTaskDueDate, addManualTask, deleteTask,
  bulkUpdateTaskStatus, listTasks, getTask,
  upsertTemplateTask, deleteTemplateTask, reorderTemplate, seedDefaultTemplate, applyStandardTemplate,
  upsertOnboardingUser, deleteOnboardingUser, setSetting,
} from "@/lib/onboarding/store";
import { OUTREACHIFY_SLACK_SETTING, CAMPAIGN_MASTERS_SETTING } from "@/lib/onboarding/automations";
import { parseMasterSettings } from "@/lib/onboarding/campaign-plan";
import { placeProblems } from "@/lib/onboarding/campaign-copy";
import { notifyOwnersOnAdd, notifyAssignee } from "@/lib/onboarding/notify";
import type { OnboardingRole, TaskStatus } from "@/lib/onboarding/generate";

const ADMIN_ACTIONS = new Set([
  "add-client", "delete-client", "set-client-group",
  "template-upsert", "template-delete", "template-reorder", "template-seed", "template-apply-standard",
  "user-upsert", "user-delete", "setting-set",
]);
// Settings the UI may change.
const SETTING_KEYS = new Set([OUTREACHIFY_SLACK_SETTING, CAMPAIGN_MASTERS_SETTING]);
const asGroup = (v: unknown): 1 | 2 | null => (Number(v) === 1 ? 1 : Number(v) === 2 ? 2 : null);

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
          group_num: asGroup(body.group_num),
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
      case "set-client-group":
        await setClientGroup(String(body.client_tag || ""), asGroup(body.group_num));
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
      case "update-task-status": {
        const session = await getSession();
        await updateTaskStatus(String(body.id || ""), body.status as TaskStatus, session?.email ?? null);
        return NextResponse.json({ ok: true });
      }
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
        const session = await getSession();
        const n = await bulkUpdateTaskStatus(ids, body.status as TaskStatus, session?.email ?? null);
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
        // day_offset null / "" = an ordered task with no due day.
        const noDay = body.day_offset == null || body.day_offset === "";
        const id = await upsertTemplateTask({
          id: body.id ?? null,
          title: String(body.title || ""),
          day_offset: noDay ? null : Number(body.day_offset) || 0,
          assignee_id: body.assignee_id ?? null,
          task_group: body.task_group ?? null,
          order_index: body.order_index != null ? Number(body.order_index) : null,
        });
        return NextResponse.json({ ok: true, id });
      }
      case "template-apply-standard": {
        const session = await getSession();
        const res = await applyStandardTemplate(session?.email ?? null);
        return NextResponse.json({ ok: true, ...res });
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
          email: body.email ?? null,
        });
        return NextResponse.json({ ok: true, id });
      }
      case "user-delete":
        await deleteOnboardingUser(String(body.id || ""));
        return NextResponse.json({ ok: true });

      // ── settings ─────────────────────────────────────────────
      case "setting-set": {
        const key = String(body.key || "");
        if (!SETTING_KEYS.has(key)) return NextResponse.json({ error: "Unknown setting" }, { status: 400 });
        if (key === CAMPAIGN_MASTERS_SETTING) {
          // Stored normalised; a group with no master tag is simply left out.
          const masters = parseMasterSettings(typeof body.value === "string" ? body.value : JSON.stringify(body.value ?? {}));
          const issues = Object.values(masters).flatMap((m) => (m ? placeProblems(m.place, `Master ${m.tag}`) : []));
          if (issues.length) return NextResponse.json({ error: issues.join(" ") }, { status: 400 });
          await setSetting(key, JSON.stringify(masters));
          return NextResponse.json({ ok: true });
        }
        // Empty = back to the default destination.
        await setSetting(key, String(body.value ?? "").trim() || null);
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
