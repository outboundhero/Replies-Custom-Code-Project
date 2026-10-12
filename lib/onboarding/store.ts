/**
 * Client Onboarding System — durable store (Turso).
 *
 * A client added to onboarding (start date) clones the standard checklist
 * template into concrete, assigned tasks: dated ones (`due_date = start_date +
 * day_offset`) and ordered ones (no due date — they run in checklist order).
 * The checklist / per-person / board UI just reads and mutates these rows.
 *
 * Mirrors the lazy `ensureTables()` + `let ready` idiom of lib/leads/move-jobs.ts.
 * Owner/assignee columns are named `*_email` for legacy reasons but hold an
 * onboarding_user id.
 */
import db from "@/lib/db";
import { randomUUID } from "crypto";
import { logActivity } from "@/lib/errors";
import { bumpVersion } from "@/lib/server-cache";
import {
  generateTasks,
  addDays,
  isValidDate,
  groupForStartDate,
  blockingTask,
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
    plan_type TEXT,
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
  // Onboarding-specific team members (NOT the Reply Router app_users). Each has a
  // Slack member ID so notifications DM them directly (no email lookup). The
  // owner/assignee columns above store this user's `id` (the *_email column names
  // are legacy; the value is an onboarding_user id).
  await db.execute(`CREATE TABLE IF NOT EXISTS onboarding_user (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slack_member_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_onboarding_task_tag ON onboarding_task(client_tag, status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_onboarding_task_assignee ON onboarding_task(assignee_email)`);
  // Small key/value settings (e.g. where the "Slack Outreachify" task posts).
  await db.execute(`CREATE TABLE IF NOT EXISTS onboarding_setting (
    key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL
  )`);
  // One row per automation run (the Run button) — the audit trail.
  await db.execute(`CREATE TABLE IF NOT EXISTS onboarding_task_run (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    client_tag TEXT NOT NULL,
    automation TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    ok INTEGER,
    run_by TEXT,
    params TEXT,
    result TEXT,
    error TEXT
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_onboarding_task_run_task ON onboarding_task_run(task_id, started_at)`);
  await addMissingColumns();
  ready = true;
}

/** Columns added after the first release (prod already has the tables): read
 *  the four table definitions once and ALTER only what's missing. */
async function addMissingColumns(): Promise<void> {
  const want: Record<string, string[]> = {
    onboarding_template_task: ["assignee_id TEXT", "no_due INTEGER NOT NULL DEFAULT 0", "automation TEXT"],
    onboarding_client: ["plan_type TEXT", "group_num INTEGER"],
    onboarding_task: ["no_due INTEGER NOT NULL DEFAULT 0", "automation TEXT", "completed_at TEXT", "completed_by TEXT", "last_run TEXT"],
    onboarding_user: ["email TEXT"],
  };
  const tables = Object.keys(want);
  const r = await db.execute({
    sql: `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map(() => "?").join(",")})`,
    args: tables,
  });
  const ddl = new Map(r.rows.map((row) => [String(row.name), String(row.sql || "")]));
  for (const table of tables) {
    for (const col of want[table]) {
      const name = col.split(" ")[0];
      if (new RegExp(`\\b${name}\\b`).test(ddl.get(table) || "")) continue;
      try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch { /* added by another server */ }
    }
  }
}

// ────────────────────────────── Types ──────────────────────────────

export interface TemplateTaskRow extends TemplateTask {
  created_at: string;
  updated_at: string;
}
export interface OnboardingClientRow {
  client_tag: string;
  client_name: string | null;
  plan_type: string | null;
  /** 1 or 2 (→ Bison instances); null until chosen. */
  group_num: 1 | 2 | null;
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
  /** 1 = ordered task (no due date; runs after the ordered tasks before it). */
  no_due: number;
  /** Automation behind the Run button, or null for a manual check-off. */
  automation: string | null;
  completed_at: string | null;
  completed_by: string | null;
  /** Summary of the latest automation run, if any. */
  last_run: LastRun | null;
  created_at: string;
  updated_at: string;
}
export interface LastRun { at: string; by: string | null; ok: boolean; summary: string }

const asTemplate = (r: Row): TemplateTaskRow => ({
  id: String(r.id),
  title: String(r.title),
  role: (String(r.role) as OnboardingRole) || "ops",
  day_offset: Number(r.day_offset) || 0,
  order_index: Number(r.order_index) || 0,
  task_group: r.task_group ? String(r.task_group) : null,
  assignee_id: r.assignee_id ? String(r.assignee_id) : null,
  no_due: Number(r.no_due) ? 1 : 0,
  automation: r.automation ? String(r.automation) : null,
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
});
function parseLastRun(v: unknown): LastRun | null {
  if (!v) return null;
  try { return JSON.parse(String(v)) as LastRun; } catch { return null; }
}
const asGroup = (v: unknown): 1 | 2 | null => (Number(v) === 1 ? 1 : Number(v) === 2 ? 2 : null);
const asClient = (row: Row): OnboardingClientRow => ({
  client_tag: String(row.client_tag),
  client_name: row.client_name ? String(row.client_name) : null,
  plan_type: row.plan_type ? String(row.plan_type) : null,
  group_num: asGroup(row.group_num),
  start_date: String(row.start_date),
  domains_owner_email: row.domains_owner_email ? String(row.domains_owner_email) : null,
  inbox_owner_email: row.inbox_owner_email ? String(row.inbox_owner_email) : null,
  ops_owner_email: row.ops_owner_email ? String(row.ops_owner_email) : null,
  status: String(row.status),
  created_by: row.created_by ? String(row.created_by) : null,
  created_at: String(row.created_at),
  updated_at: String(row.updated_at),
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
  no_due: Number(r.no_due) ? 1 : 0,
  automation: r.automation ? String(r.automation) : null,
  completed_at: r.completed_at ? String(r.completed_at) : null,
  completed_by: r.completed_by ? String(r.completed_by) : null,
  last_run: parseLastRun(r.last_run),
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

/** The standard checklist's owners (Nick / Madison / Spencer) as onboarding_user
 *  ids — matched by first name, created when missing. */
async function standardOwnerIds(): Promise<Map<string, string>> {
  const users = await listOnboardingUsers();
  const out = new Map<string, string>();
  for (const owner of new Set(DEFAULT_TEMPLATE.map((t) => t.owner))) {
    const hit = users.find((u) => u.name.trim().toLowerCase().split(/\s+/)[0] === owner.toLowerCase());
    out.set(owner, hit ? hit.id : await upsertOnboardingUser({ name: owner }));
  }
  return out;
}

function standardTemplateInserts(owners: Map<string, string>, now: string) {
  return DEFAULT_TEMPLATE.map((t, i) => ({
    sql: `INSERT INTO onboarding_template_task
            (id, title, role, day_offset, order_index, task_group, assignee_id, no_due, automation, created_at, updated_at)
          VALUES (?, ?, 'ops', ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [randomUUID(), t.title, t.day ?? 0, i, t.task_group, owners.get(t.owner) ?? null,
           t.day == null ? 1 : 0, t.automation ?? null, now, now],
  }));
}

/** Seed the standard template only when it's empty (idempotent). Returns count inserted. */
export async function seedDefaultTemplate(): Promise<number> {
  await ensureTables();
  const existing = await db.execute("SELECT COUNT(*) AS c FROM onboarding_template_task");
  if (Number(existing.rows[0]?.c) > 0) return 0;
  const owners = await standardOwnerIds();
  await db.batch(standardTemplateInserts(owners, nowIso()), "write");
  bumpVersion("onboarding");
  return DEFAULT_TEMPLATE.length;
}

/**
 * Replace the whole template with the standard checklist. The previous template
 * is kept in onboarding_setting (`template_backup:<time>`) so nothing is lost.
 * Only affects clients added afterward — existing clients keep their tasks.
 */
export async function applyStandardTemplate(by: string | null): Promise<{ replaced: number; inserted: number }> {
  await ensureTables();
  const previous = await listTemplate();
  const owners = await standardOwnerIds();
  const now = nowIso();
  await db.batch(
    [
      { sql: "INSERT OR REPLACE INTO onboarding_setting (key, value, updated_at) VALUES (?, ?, ?)",
        args: [`template_backup:${now}`, JSON.stringify({ by, tasks: previous }), now] },
      { sql: "DELETE FROM onboarding_template_task", args: [] },
      ...standardTemplateInserts(owners, now),
    ],
    "write",
  );
  bumpVersion("onboarding");
  await logActivity("onboarding", "template-replaced", { details: { by, replaced: previous.length, inserted: DEFAULT_TEMPLATE.length } });
  return { replaced: previous.length, inserted: DEFAULT_TEMPLATE.length };
}

export async function upsertTemplateTask(input: {
  id?: string | null;
  title: string;
  role?: OnboardingRole;
  /** Day N; null = ordered task with no due day. */
  day_offset: number | null;
  assignee_id?: string | null;
  task_group?: string | null;
  order_index?: number | null;
}): Promise<string> {
  await ensureTables();
  const now = nowIso();
  const title = input.title.trim();
  if (!title) throw new Error("title required");
  const noDue = input.day_offset == null ? 1 : 0;
  const day = input.day_offset == null ? 0 : input.day_offset | 0;
  const assignee = input.assignee_id?.trim() || null;
  if (input.id) {
    // Position, group and automation are kept — the editor changes what a task
    // says, who owns it and when it's due.
    await db.execute({
      sql: `UPDATE onboarding_template_task
            SET title=?, day_offset=?, no_due=?, assignee_id=?, updated_at=?
            WHERE id=?`,
      args: [title, day, noDue, assignee, now, input.id],
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
            (id, title, role, day_offset, order_index, task_group, assignee_id, no_due, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, title, input.role || "ops", day, order, input.task_group ?? null, assignee, noDue, now, now],
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

// ─────────────────────────── Onboarding users ───────────────────────────

export interface OnboardingUserRow {
  id: string;
  name: string;
  slack_member_id: string | null;
  /** Their Reply Router login — opens their own task view by default. */
  email: string | null;
}

export async function listOnboardingUsers(): Promise<OnboardingUserRow[]> {
  await ensureTables();
  const r = await db.execute("SELECT id, name, slack_member_id, email FROM onboarding_user ORDER BY name COLLATE NOCASE ASC");
  return r.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    slack_member_id: row.slack_member_id ? String(row.slack_member_id) : null,
    email: row.email ? String(row.email) : null,
  }));
}

/** Map onboarding_user id → { name, slackId } for display + notifications. */
export async function onboardingUserMap(): Promise<Map<string, { name: string; slackId: string | null }>> {
  const users = await listOnboardingUsers();
  return new Map(users.map((u) => [u.id, { name: u.name, slackId: u.slack_member_id }]));
}

export async function upsertOnboardingUser(input: { id?: string | null; name: string; slack_member_id?: string | null; email?: string | null }): Promise<string> {
  await ensureTables();
  const name = input.name.trim();
  if (!name) throw new Error("name required");
  const slack = input.slack_member_id?.trim() || null;
  const email = input.email?.trim().toLowerCase() || null;
  const now = nowIso();
  if (input.id) {
    await db.execute({
      sql: "UPDATE onboarding_user SET name=?, slack_member_id=?, email=?, updated_at=? WHERE id=?",
      args: [name, slack, email, now, input.id],
    });
    bumpVersion("onboarding");
    return input.id;
  }
  const id = randomUUID();
  await db.execute({
    sql: "INSERT INTO onboarding_user (id, name, slack_member_id, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [id, name, slack, email, now, now],
  });
  bumpVersion("onboarding");
  return id;
}

/** Remove a team member. Refused while they still own template tasks or open
 *  tasks — those would be left pointing at nobody. */
export async function deleteOnboardingUser(id: string): Promise<void> {
  await ensureTables();
  const owns = await db.execute({
    sql: `SELECT (SELECT COUNT(*) FROM onboarding_template_task WHERE assignee_id = ?) AS tpl,
                 (SELECT COUNT(*) FROM onboarding_task WHERE assignee_email = ? AND status != 'completed') AS open`,
    args: [id, id],
  });
  const tpl = Number(owns.rows[0]?.tpl) || 0;
  const open = Number(owns.rows[0]?.open) || 0;
  if (tpl || open) {
    const parts = [tpl ? `${tpl} template task${tpl === 1 ? "" : "s"}` : "", open ? `${open} open task${open === 1 ? "" : "s"}` : ""].filter(Boolean);
    throw new Error(`They still own ${parts.join(" and ")} — give those to someone else first.`);
  }
  await db.execute({ sql: "DELETE FROM onboarding_user WHERE id=?", args: [id] });
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
               due_date, assignee_email, status, order_index, due_date_overridden, no_due, automation, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_started', ?, 0, ?, ?, ?, ?)`,
      args: [randomUUID(), t.client_tag, t.template_task_id, t.title, t.role, t.task_group,
             t.day_offset, t.due_date, t.assignee_email, t.order_index, t.no_due, t.automation, now, now],
    })),
    "write",
  );
}

export interface AddClientInput {
  client_tag: string;
  client_name?: string | null;
  plan_type?: string | null;
  /** 1 or 2; when omitted it follows the start-date rule (1st → 2, 15th → 1). */
  group_num?: 1 | 2 | null;
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
  const group = asGroup(input.group_num) ?? groupForStartDate(input.start_date);
  await db.execute({
    sql: `INSERT INTO onboarding_client
            (client_tag, client_name, plan_type, group_num, start_date, domains_owner_email, inbox_owner_email,
             ops_owner_email, status, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
          ON CONFLICT(client_tag) DO UPDATE SET
            client_name = excluded.client_name,
            plan_type = excluded.plan_type,
            group_num = excluded.group_num,
            start_date = excluded.start_date,
            domains_owner_email = excluded.domains_owner_email,
            inbox_owner_email = excluded.inbox_owner_email,
            ops_owner_email = excluded.ops_owner_email,
            updated_at = excluded.updated_at`,
    args: [tag, input.client_name?.trim() || null, input.plan_type?.trim() || null, group, input.start_date,
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
 *  existing ones — a template task counts as present when the client already
 *  has it by id, or by title (replacing the template gives its tasks new ids). */
export async function regenerateTasks(tag: string): Promise<number> {
  await ensureTables();
  const client = await getClient(tag);
  if (!client) throw new Error("client not onboarded");
  const template = await listTemplate();
  const existing = await db.execute({
    sql: "SELECT template_task_id, title FROM onboarding_task WHERE client_tag=?",
    args: [client.client_tag],
  });
  const have = new Set(existing.rows.filter((r) => r.template_task_id).map((r) => String(r.template_task_id)));
  const haveTitles = new Set(existing.rows.map((r) => String(r.title).trim().toLowerCase()));
  const missing = template.filter((t) => !have.has(t.id) && !haveTitles.has(t.title.trim().toLowerCase()));
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
    ...asClient(row),
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
  return row ? asClient(row) : null;
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
  // Ordered tasks have no due date — only dated, non-overridden ones move.
  const tasks = await db.execute({
    sql: "SELECT id, day_offset FROM onboarding_task WHERE client_tag=? AND due_date_overridden=0 AND COALESCE(no_due, 0)=0",
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

/** Set the client's group (1 or 2 → which Bison instances it uses). */
export async function setClientGroup(tag: string, group: 1 | 2 | null): Promise<void> {
  await ensureTables();
  await db.execute({
    sql: "UPDATE onboarding_client SET group_num=?, updated_at=? WHERE UPPER(client_tag)=UPPER(?)",
    args: [asGroup(group), nowIso(), tag],
  });
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

export async function getTask(id: string): Promise<OnboardingTaskRow | null> {
  await ensureTables();
  const r = await db.execute({ sql: "SELECT * FROM onboarding_task WHERE id=?", args: [id] });
  return r.rows[0] ? asTask(r.rows[0]) : null;
}

/** Ordered tasks run in checklist order: throws (with the task to finish first)
 *  when `task` can't be started or completed yet. Reopening is always allowed. */
async function assertInOrder(task: OnboardingTaskRow, status: TaskStatus, treatAsDone: Set<string> = new Set()): Promise<void> {
  if (status === "not_started" || !task.no_due) return;
  const siblings = (await listTasks({ tag: task.client_tag }))
    .map((t) => (treatAsDone.has(t.id) ? { ...t, status: "completed" as TaskStatus } : t));
  const blocker = blockingTask(task, siblings);
  if (blocker) throw new Error(`Finish "${blocker.title}" first — these steps run in order.`);
}

export async function updateTaskStatus(id: string, status: TaskStatus, by: string | null = null): Promise<void> {
  await ensureTables();
  const task = await getTask(id);
  if (!task) throw new Error("task not found");
  await assertInOrder(task, status);
  const now = nowIso();
  const done = status === "completed";
  await db.execute({
    sql: "UPDATE onboarding_task SET status=?, completed_at=?, completed_by=?, updated_at=? WHERE id=?",
    args: [status, done ? (task.completed_at ?? now) : null, done ? (task.completed_by ?? by) : null, now, id],
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

/** Set the same status on many tasks at once (bulk action from the UI). Ordered
 *  tasks still have to be in order — selecting steps 1–3 together is fine,
 *  selecting step 3 alone before 1–2 are done is refused. */
export async function bulkUpdateTaskStatus(ids: string[], status: TaskStatus, by: string | null = null): Promise<number> {
  await ensureTables();
  const clean = [...new Set(ids.filter(Boolean))];
  if (!clean.length) return 0;
  const tasks = (await Promise.all(clean.map((id) => getTask(id)))).filter((t): t is OnboardingTaskRow => !!t);
  if (status !== "not_started") {
    const batch = new Set(tasks.map((t) => t.id));
    for (const t of tasks) await assertInOrder(t, status, batch);
  }
  const now = nowIso();
  const done = status === "completed";
  await db.batch(
    tasks.map((t) => ({
      sql: "UPDATE onboarding_task SET status=?, completed_at=?, completed_by=?, updated_at=? WHERE id=?",
      args: [status, done ? (t.completed_at ?? now) : null, done ? (t.completed_by ?? by) : null, now, t.id],
    })),
    "write",
  );
  bumpVersion("onboarding");
  return tasks.length;
}

// ─────────────────────────── Settings ───────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  await ensureTables();
  const r = await db.execute({ sql: "SELECT value FROM onboarding_setting WHERE key=?", args: [key] });
  return r.rows[0]?.value != null ? String(r.rows[0].value) : null;
}

export async function setSetting(key: string, value: string | null): Promise<void> {
  await ensureTables();
  await db.execute({
    sql: "INSERT OR REPLACE INTO onboarding_setting (key, value, updated_at) VALUES (?, ?, ?)",
    args: [key, value, nowIso()],
  });
  bumpVersion("onboarding");
}

// ─────────────────────────── Automation runs ───────────────────────────

/** Record the start of an automation run; returns its id. */
export async function startRun(task: OnboardingTaskRow, by: string | null, params: unknown): Promise<string> {
  await ensureTables();
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO onboarding_task_run (id, task_id, client_tag, automation, started_at, run_by, params)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, task.id, task.client_tag, task.automation || "", nowIso(), by, JSON.stringify(params ?? {})],
  });
  return id;
}

/**
 * Record how a run ended. On success the task is marked Done (stamped with who
 * ran it); either way the task keeps a one-line summary of its latest run.
 */
export async function finishRun(
  runId: string, task: OnboardingTaskRow, by: string | null,
  outcome: { ok: boolean; summary: string; result?: unknown },
): Promise<void> {
  const now = nowIso();
  const last: LastRun = { at: now, by, ok: outcome.ok, summary: outcome.summary.slice(0, 500) };
  await db.batch(
    [
      { sql: "UPDATE onboarding_task_run SET finished_at=?, ok=?, result=?, error=? WHERE id=?",
        args: [now, outcome.ok ? 1 : 0, JSON.stringify(outcome.result ?? null), outcome.ok ? null : outcome.summary.slice(0, 1000), runId] },
      outcome.ok
        ? { sql: "UPDATE onboarding_task SET status='completed', completed_at=?, completed_by=?, last_run=?, updated_at=? WHERE id=?",
            args: [now, by, JSON.stringify(last), now, task.id] }
        : { sql: "UPDATE onboarding_task SET last_run=?, updated_at=? WHERE id=?",
            args: [JSON.stringify(last), now, task.id] },
    ],
    "write",
  );
  bumpVersion("onboarding");
}

/** In-order check for the Run button (same rule as a manual status change). */
export async function assertTaskCanRun(task: OnboardingTaskRow): Promise<void> {
  await assertInOrder(task, "completed");
}
