import db from "@/lib/db";

/**
 * Log an error to the database.
 */
export async function logError(
  workflow: string,
  stage: string,
  message: string,
  payload?: unknown
) {
  try {
    await db.execute({
      sql: "INSERT INTO error_log (workflow, stage, message, payload) VALUES (?, ?, ?, ?)",
      args: [workflow, stage, message, payload ? JSON.stringify(payload) : null],
    });
  } catch {
    console.error("Failed to log error to DB:", { workflow, stage, message });
  }
}

/**
 * Log an activity to the database.
 */
export async function logActivity(
  workflow: string,
  action: string,
  opts?: {
    client_tag?: string;
    section_name?: string;
    lead_email?: string;
    details?: unknown;
  }
) {
  try {
    await db.execute({
      sql: `INSERT INTO activity_log (workflow, client_tag, section_name, lead_email, action, details)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        workflow,
        opts?.client_tag || null,
        opts?.section_name || null,
        opts?.lead_email || null,
        action,
        opts?.details ? JSON.stringify(opts.details) : null,
      ],
    });
  } catch {
    console.error("Failed to log activity:", { workflow, action });
  }
}
