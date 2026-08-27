/**
 * Client Onboarding System — durable store (Turso).
 *
 * A client added to onboarding (start date + role owners) clones the standard
 * task template into concrete, dated, assigned tasks (`due_date = start_date +
 * day_offset`). The board/detail/my-tasks UI just reads and mutates these rows.
 *
 * Mirrors the lazy `ensureTables()` + `let ready` idiom of lib/leads/move-jobs.ts.
 * Assignee emails are plain TEXT cross-store references to Supabase `app_users`
 * (like `move_job.created_by`).
 */
import db from "@/lib/db";
import { randomUUID } from "crypto";
import { logActivity } from "@/lib/errors";
import { bumpVersion } from "@/lib/server-cache";
import {
  generateTasks,
  addDays,
  isValidDate,
  type OnboardingRole,
  type TaskStatus,
  type TemplateTask,
  type GeneratedTask,
} from "@/lib/onboarding/generate";
import { DEFAULT_TEMPLATE } from "@/lib/onboarding/seed";

const nowIso = () => new Date().toISOString();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

let ready = false;
async function ensureTables(): Promise<void> {
  if (ready) return;
  await db.execute(`CREATE TABLE IF NOT EXISTS onboarding_template_task (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'ops',
    day_offset INTEGER NOT NULL DEFAULT 0,
    order_index INTEGER NOT NULL DEFAULT 0,
    task_group TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS onboarding_client (
    client_tag TEXT PRIMARY KEY,
    client_name TEXT,
    start_date TEXT NOT NULL,
    domains_owner_email TEXT,
    inbox_owner_email TEXT,
    ops_owner_email TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS onboarding_task (
    id TEXT PRIMARY KEY,
    client_tag TEXT NOT NULL,
    template_task_id TEXT,
    title TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'ops',
    task_group TEXT,
    day_offset INTEGER NOT NULL DEFAULT 0,
    due_date TEXT,
    assignee_email TEXT,
    status TEXT NOT NULL DEFAULT 'not_started',
    order_index INTEGER NOT NULL DEFAULT 0,
    due_date_overridden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_onboarding_task_tag ON onboarding_task(client_tag, status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_onboarding_task_assignee ON onboarding_task(assignee_email)`);
  ready = true;
}

// ────────────────────────────── Types ──────────────────────────────

export interface TemplateTaskRow extends TemplateTask {
  created_at: string;
  updated_at: string;
}
export interface OnboardingClientRow {
  client_tag: string;
  client_name: string | null;
  start_date: string;
  domains_owner_email: string | null;
  inbox_owner_email: string | null;
  ops_owner_email: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  tasks_total?: number;
  tasks_done?: number;
}
export interface OnboardingTaskRow {
  id: string;
  client_tag: string;
  template_task_id: string | null;
  title: string;
  role: OnboardingRole;
  task_group: string | null;
  day_offset: number;
  due_date: string | null;
  assignee_email: string | null;
  status: TaskStatus;
  order_index: number;
  due_date_overridden: number;
  created_at: string;
  updated_at: string;
}

const asTemplate = (r: Row): TemplateTaskRow => ({
  id: String(r.id),
  title: String(r.title),
  role: (String(r.role) as OnboardingRole) || "ops",
  day_offset: Number(r.day_offset) || 0,
  order_index: Number(r.order_index) || 0,
  task_group: r.task_group ? String(r.task_group) : null,
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
});
const asTask = (r: Row): OnboardingTaskRow => ({
  id: String(r.id),
  client_tag: String(r.client_tag),
  template_task_id: r.template_task_id ? String(r.template_task_id) : null,
  title: String(r.title),
  role: (String(r.role) as OnboardingRole) || "ops",
  task_group: r.task_group ? String(r.task_group) : null,
  day_offset: Number(r.day_offset) || 0,
  due_date: r.due_date ? String(r.due_date) : null,
  assignee_email: r.assignee_email ? String(r.assignee_email) : null,
  status: (String(r.status) as TaskStatus) || "not_started",
  order_index: Number(r.order_index) || 0,
  due_date_overridden: Number(r.due_date_overridden) || 0,
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
});

// ─────────────────────────── Template CRUD ───────────────────────────

export async function listTemplate(): Promise<TemplateTaskRow[]> {
  await ensureTables();
  const r = await db.execute(
    "SELECT * FROM onboarding_template_task ORDER BY order_index ASC, day_offset ASC",
  );
  return r.rows.map(asTemplate);
}

/** Seed the standard template only when it's empty (idempotent). Returns count inserted. */
export async function seedDefaultTemplate(): Promise<number> {
  await ensureTables();
  const existing = await db.execute("SELECT COUNT(*) AS c FROM onboarding_template_task");
  if (Number(existing.rows[0]?.c) > 0) return 0;
  const now = nowIso();
  await db.batch(
    DEFAULT_TEMPLATE.map((t, i) => ({
      sql: `INSERT INTO onboarding_template_task
              (id, title, role, day_offset, order_index, task_group, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [randomUUID(), t.title, t.role, t.day_offset, i, t.task_group, now, now],
    })),
    "write",
  );
  bumpVersion("onboarding");
  return DEFAULT_TEMPLATE.length;
}

export async function upsertTemplateTask(input: {
  id?: string | null;
  title: string;
  role: OnboardingRole;
  day_offset: number;
  task_group?: string | null;
  order_index?: number | null;
}): Promise<string> {
  await ensureTables();
  const now = nowIso();
  const title = input.title.trim();
  if (!title) throw new Error("title required");
  if (input.id) {
    await db.execute({
      sql: `UPDATE onboarding_template_task
            SET title=?, role=?, day_offset=?, task_group=?, order_index=?, updated_at=?
            WHERE id=?`,
      args: [title, input.role, input.day_offset | 0, input.task_group ?? null,
             input.order_index ?? 0, now, input.id],
    });
    bumpVersion("onboarding");
    return input.id;
  }
  // New task appended to the end unless an explicit order is given.
  let order = input.order_index;
  if (order == null) {
    const m = await db.execute("SELECT COALESCE(MAX(order_index), -1) AS mx FROM onboarding_template_task");
    order = Number(m.rows[0]?.mx) + 1;
  }
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO onboarding_template_task
            (id, title, role, day_offset, order_index, task_group, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, title, input.role, input.day_offset | 0, order, input.task_group ?? null, now, now],
  });
  bumpVersion("onboarding");
  return id;
}

export async function deleteTemplateTask(id: string): Promise<void> {
  await ensureTables();
  await db.execute({ sql: "DELETE FROM onboarding_template_task WHERE id=?", args: [id] });
  bumpVersion("onboarding");
}

/** Persist a new order (array of template task ids in desired order). */
export async function reorderTemplate(orderedIds: string[]): Promise<void> {
  await ensureTables();
  const now = nowIso();
  await db.batch(
    orderedIds.map((id, i) => ({
      sql: "UPDATE onboarding_template_task SET order_index=?, updated_at=? WHERE id=?",
      args: [i, now, id],
    })),
    "write",
  );
  bumpVersion("onboarding");
}

// ─────────────────────────── Client + generation ───────────────────────────

/** Ensure a client_tags roster row exists for this tag (create if new), mirroring
 *  the config/clients `create` action. Uses the first section as a default home. */
async function ensureClientTag(tag: string): Promise<void> {
  const existing = await db.execute({
    sql: "SELECT 1 FROM client_tags WHERE UPPER(tag)=UPPER(?) LIMIT 1",
    args: [tag],
  });
  if (existing.rows.length) return;
  const sec = await db.execute("SELECT id FROM sections ORDER BY id ASC LIMIT 1");
  const sectionId = sec.rows[0]?.id;
  if (sectionId == null) return; // no sections yet — onboarding row still stands
  try {
    await db.execute({ sql: "INSERT INTO client_tags (tag, section_id) VALUES (?, ?)", args: [tag, sectionId] });
    await db.execute({ sql: "INSERT OR IGNORE INTO client_config (client_tag) VALUES (?)", args: [tag] });
  } catch { /* raced / already exists */ }
}

/** Insert generated task rows for a client, idempotent on (client_tag, template_task_id). */
async function insertGeneratedTasks(tasks: GeneratedTask[]): Promise<void> {
  if (!tasks.length) return;
  const now = nowIso();
  await db.batch(
    tasks.map((t) => ({
      sql: `INSERT INTO onboarding_task
              (id, client_tag, template_task_id, title, role, task_group, day_offset,
               due_date, assignee_email, status, order_index, due_date_overridden, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_started', ?, 0, ?, ?)`,
      args: [randomUUID(), t.client_tag, t.template_task_id, t.title, t.role, t.task_group,
             t.day_offset, t.due_date, t.assignee_email, t.order_index, now, now],
    })),
    "write",
  );
}

export interface AddClientInput {
  client_tag: string;
  client_name?: string | null;
  start_date: string;
  domains_owner_email?: string | null;
  inbox_owner_email?: string | null;
  ops_owner_email?: string | null;
  created_by?: string | null;
}

/** Add a client to onboarding: ensure the roster tag exists, upsert the onboarding
 *  row, and generate its task timeline from the (seeded) template. */
export async function addOnboardingClient(input: AddClientInput): Promise<{ client_tag: string; tasks: number }> {
  await ensureTables();
  const tag = input.client_tag.trim().toUpperCase();
  if (!tag) throw new Error("client_tag required");
  if (!isValidDate(input.start_date)) throw new Error("start_date must be YYYY-MM-DD");

  await ensureClientTag(tag);
  await seedDefaultTemplate(); // no-op if template already exists

  const now = nowIso();
  await db.execute({
    sql: `INSERT INTO onboarding_client
            (client_tag, client_name, start_date, domains_owner_email, inbox_owner_email,
             ops_owner_email, status, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
          ON CONFLICT(client_tag) DO UPDATE SET
            client_name = excluded.client_name,
            start_date = excluded.start_date,
            domains_owner_email = excluded.domains_owner_email,
            inbox_owner_email = excluded.inbox_owner_email,
            ops_owner_email = excluded.ops_owner_email,
            updated_at = excluded.updated_at`,
    args: [tag, input.client_name?.trim() || null, input.start_date,
           input.domains_owner_email?.trim() || null, input.inbox_owner_email?.trim() || null,
           input.ops_owner_email?.trim() || null, input.created_by || null, now, now],
  });

  // Generate tasks only if this client has none yet (idempotent add).
  const has = await db.execute({
    sql: "SELECT COUNT(*) AS c FROM onboarding_task WHERE client_tag=?",
    args: [tag],
  });
  let generated = 0;
  if (Number(has.rows[0]?.c) === 0) {
    const template = await listTemplate();
    const tasks = generateTasks(
      {
        client_tag: tag,
        start_date: input.start_date,
        domains_owner_email: input.domains_owner_email?.trim() || null,
        inbox_owner_email: input.inbox_owner_email?.trim() || null,
        ops_owner_email: input.ops_owner_email?.trim() || null,
      },
      template,
    );
    await insertGeneratedTasks(tasks);
    generated = tasks.length;
  }

  bumpVersion("onboarding");
  await logActivity("onboarding", "tasks-generated", {
    client_tag: tag,
    details: { count: generated, start_date: input.start_date },
  });
  return { client_tag: tag, tasks: generated };
}

/** (Re)generate any template tasks a client is missing, without duplicating
 *  existing ones — idempotent on (client_tag, template_task_id). */
export async function regenerateTasks(tag: string): Promise<number> {
  await ensureTables();
  const client = await getClient(tag);
  if (!client) throw new Error("client not onboarded");
  const template = await listTemplate();
  const existing = await db.execute({
    sql: "SELECT template_task_id FROM onboarding_task WHERE client_tag=? AND template_task_id IS NOT NULL",
    args: [client.client_tag],
  });
  const have = new Set(existing.rows.map((r) => String(r.template_task_id)));
  const missing = template.filter((t) => !have.has(t.id));
  if (!missing.length) return 0;
  const tasks = generateTasks(
    {
      client_tag: client.client_tag,
      start_date: client.start_date,
      domains_owner_email: client.domains_owner_email,
      inbox_owner_email: client.inbox_owner_email,
      ops_owner_email: client.ops_owner_email,
    },
    missing,
  );
  await insertGeneratedTasks(tasks);
  bumpVersion("onboarding");
  return tasks.length;
}

export async function listClients(): Promise<OnboardingClientRow[]> {
  await ensureTables();
  const r = await db.execute(`
    SELECT c.*,
           COALESCE(t.total, 0) AS tasks_total,
           COALESCE(t.done, 0) AS tasks_done
    FROM onboarding_client c
    LEFT JOIN (
      SELECT client_tag,
             COUNT(*) AS total,
             SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS done
      FROM onboarding_task GROUP BY client_tag
    ) t ON t.client_tag = c.client_tag
    ORDER BY c.status ASC, c.start_date DESC`);
  return r.rows.map((row) => ({
    client_tag: String(row.client_tag),
    client_name: row.client_name ? String(row.client_name) : null,
    start_date: String(row.start_date),
    domains_owner_email: row.domains_owner_email ? String(row.domains_owner_email) : null,
    inbox_owner_email: row.inbox_owner_email ? String(row.inbox_owner_email) : null,
    ops_owner_email: row.ops_owner_email ? String(row.ops_owner_email) : null,
    status: String(row.status),
    created_by: row.created_by ? String(row.created_by) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    tasks_total: Number(row.tasks_total) || 0,
    tasks_done: Number(row.tasks_done) || 0,
  }));
}

export async function getClient(tag: string): Promise<OnboardingClientRow | null> {
  await ensureTables();
  const r = await db.execute({
    sql: "SELECT * FROM onboarding_client WHERE UPPER(client_tag)=UPPER(?)",
    args: [tag],
  });
  const row = r.rows[0];
  if (!row) return null;
  return {
    client_tag: String(row.client_tag),
    client_name: row.client_name ? String(row.client_name) : null,
    start_date: String(row.start_date),
    domains_owner_email: row.domains_owner_email ? String(row.domains_owner_email) : null,
    inbox_owner_email: row.inbox_owner_email ? String(row.inbox_owner_email) : null,
    ops_owner_email: row.ops_owner_email ? String(row.ops_owner_email) : null,
    status: String(row.status),
    created_by: row.created_by ? String(row.created_by) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/** Move a client's start date; shift every non-overridden task's due_date to
 *  `start_date + day_offset`. Manually-edited due dates (overridden) stay put. */
export async function updateClientStartDate(tag: string, startDate: string): Promise<void> {
  await ensureTables();
  if (!isValidDate(startDate)) throw new Error("start_date must be YYYY-MM-DD");
  const client = await getClient(tag);
  if (!client) throw new Error("client not onboarded");
  const now = nowIso();
  await db.execute({
    sql: "UPDATE onboarding_client SET start_date=?, updated_at=? WHERE client_tag=?",
    args: [startDate, now, client.client_tag],
  });
  const tasks = await db.execute({
    sql: "SELECT id, day_offset FROM onboarding_task WHERE client_tag=? AND due_date_overridden=0",
    args: [client.client_tag],
  });
  if (tasks.rows.length) {
    await db.batch(
      tasks.rows.map((t) => ({
        sql: "UPDATE onboarding_task SET due_date=?, updated_at=? WHERE id=?",
        args: [addDays(startDate, Number(t.day_offset) || 0), now, String(t.id)],
      })),
      "write",
    );
  }
  bumpVersion("onboarding");
}

export async function setClientStatus(tag: string, status: "active" | "completed"): Promise<void> {
  await ensureTables();
  await db.execute({
    sql: "UPDATE onboarding_client SET status=?, updated_at=? WHERE UPPER(client_tag)=UPPER(?)",
    args: [status, nowIso(), tag],
  });
  bumpVersion("onboarding");
}

export async function deleteOnboardingClient(tag: string): Promise<void> {
  await ensureTables();
  await db.execute({ sql: "DELETE FROM onboarding_task WHERE UPPER(client_tag)=UPPER(?)", args: [tag] });
  await db.execute({ sql: "DELETE FROM onboarding_client WHERE UPPER(client_tag)=UPPER(?)", args: [tag] });
  bumpVersion("onboarding");
}

// ─────────────────────────── Task CRUD ───────────────────────────

export async function listTasks(filter?: { tag?: string; assignee?: string }): Promise<OnboardingTaskRow[]> {
  await ensureTables();
  const clauses: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any[] = [];
  if (filter?.tag) { clauses.push("UPPER(client_tag)=UPPER(?)"); args.push(filter.tag); }
  if (filter?.assignee) { clauses.push("assignee_email=?"); args.push(filter.assignee); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const r = await db.execute({
    sql: `SELECT * FROM onboarding_task ${where} ORDER BY due_date ASC, order_index ASC`,
    args,
  });
  return r.rows.map(asTask);
}

export async function updateTaskStatus(id: string, status: TaskStatus): Promise<void> {
  await ensureTables();
  await db.execute({
    sql: "UPDATE onboarding_task SET status=?, updated_at=? WHERE id=?",
    args: [status, nowIso(), id],
  });
  bumpVersion("onboarding");
}

export async function updateTaskAssignee(id: string, email: string | null): Promise<void> {
  await ensureTables();
  await db.execute({
    sql: "UPDATE onboarding_task SET assignee_email=?, updated_at=? WHERE id=?",
    args: [email?.trim() || null, nowIso(), id],
  });
  bumpVersion("onboarding");
}

export async function updateTaskDueDate(id: string, dueDate: string): Promise<void> {
  await ensureTables();
  if (!isValidDate(dueDate)) throw new Error("due_date must be YYYY-MM-DD");
  await db.execute({
    sql: "UPDATE onboarding_task SET due_date=?, due_date_overridden=1, updated_at=? WHERE id=?",
    args: [dueDate, nowIso(), id],
  });
  bumpVersion("onboarding");
}

export async function addManualTask(input: {
  client_tag: string;
  title: string;
  role?: OnboardingRole;
  due_date?: string | null;
  assignee_email?: string | null;
  task_group?: string | null;
}): Promise<string> {
  await ensureTables();
  const tag = input.client_tag.trim().toUpperCase();
  const title = input.title.trim();
  if (!title) throw new Error("title required");
  const now = nowIso();
  const id = randomUUID();
  const dueDate = input.due_date && isValidDate(input.due_date) ? input.due_date : null;
  const overridden = dueDate ? 1 : 0;
  const m = await db.execute({
    sql: "SELECT COALESCE(MAX(order_index), -1) AS mx FROM onboarding_task WHERE client_tag=?",
    args: [tag],
  });
  const order = Number(m.rows[0]?.mx) + 1;
  await db.execute({
    sql: `INSERT INTO onboarding_task
            (id, client_tag, template_task_id, title, role, task_group, day_offset,
             due_date, assignee_email, status, order_index, due_date_overridden, created_at, updated_at)
          VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?, 'not_started', ?, ?, ?, ?)`,
    args: [id, tag, title, input.role || "ops", input.task_group ?? null,
           dueDate, input.assignee_email?.trim() || null, order, overridden, now, now],
  });
  bumpVersion("onboarding");
  return id;
}

export async function deleteTask(id: string): Promise<void> {
  await ensureTables();
  await db.execute({ sql: "DELETE FROM onboarding_task WHERE id=?", args: [id] });
  bumpVersion("onboarding");
}
