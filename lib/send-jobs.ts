/**
 * Send Reply in the background.
 *
 * Email Bison sends the email before it answers, which took 1.5–8 s on real
 * sends (2026-10-14) — on top of everything else in the request, the team
 * waited 10–20 s per click. Now the inbox hands the send over and gets an
 * answer at once; the send itself runs right after the response (the same
 * function keeps running) and its outcome is recorded here. The browser asks
 * for that outcome every second or so and shows "Sent" or the error.
 *
 * One row per send. At most one send per lead can be in flight — the database
 * refuses a second (unique index on unfinished rows), so a double click or two
 * people on the same lead can never email it twice. A send that never reported
 * back (its function was cut off) counts as "unknown" after a few minutes and
 * stops blocking the lead.
 *
 * Each row also keeps timings (how long until the click was answered, how long
 * Email Bison took, whether the server was cold) so the speed can be checked.
 */
import { randomUUID } from "crypto";
import db from "@/lib/db";

export type SendJobStatus = "sending" | "sent" | "failed" | "unknown";

/** A send not finished after this long is treated as cut off. */
const STALE_MS = 3 * 60_000;

let ready: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  ready ??= (async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS inbox_send_job (
      id TEXT PRIMARY KEY,
      reply_row_id INTEGER NOT NULL,
      client_tag TEXT,
      lead_email TEXT,
      by_email TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      accept_ms INTEGER,
      bison_ms INTEGER,
      total_ms INTEGER,
      cold INTEGER
    )`);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_send_job_active ON inbox_send_job(reply_row_id) WHERE status = 'sending'`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_inbox_send_job_created ON inbox_send_job(created_at)`);
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

/**
 * Claim the lead for one send. Returns the job id, or who is already sending
 * to it. Sends that never finished are closed first, so they can't block.
 */
export async function claimSendJob(input: {
  replyRowId: number; clientTag: string | null; leadEmail: string | null; by: string | null; cold: boolean;
}): Promise<{ id: string } | { busy: { by: string | null; since: string } }> {
  await ensureTable();
  const now = new Date();
  await db.execute({
    sql: "UPDATE inbox_send_job SET status = 'unknown', error = 'never reported back', finished_at = ? WHERE reply_row_id = ? AND status = 'sending' AND created_at < ?",
    args: [now.toISOString(), input.replyRowId, new Date(now.getTime() - STALE_MS).toISOString()],
  });
  const id = randomUUID();
  try {
    await db.execute({
      sql: `INSERT INTO inbox_send_job (id, reply_row_id, client_tag, lead_email, by_email, status, created_at, cold)
            VALUES (?, ?, ?, ?, ?, 'sending', ?, ?)`,
      args: [id, input.replyRowId, input.clientTag, input.leadEmail, input.by, now.toISOString(), input.cold ? 1 : 0],
    });
    return { id };
  } catch (e) {
    if (!/unique|constraint/i.test((e as Error).message)) throw e;
    const r = await db.execute({
      sql: "SELECT by_email, created_at FROM inbox_send_job WHERE reply_row_id = ? AND status = 'sending' LIMIT 1",
      args: [input.replyRowId],
    });
    const row = r.rows[0];
    return { busy: { by: row ? (row.by_email as string | null) : null, since: row ? String(row.created_at) : now.toISOString() } };
  }
}

/** Record how a send ended. Retried a few times — the outcome is what the browser is waiting for. */
export async function finishSendJob(
  id: string,
  outcome: { ok: boolean; error?: string },
  timings: { acceptMs: number; bisonMs: number | null; totalMs: number },
): Promise<void> {
  await ensureTable();
  for (let attempt = 0; ; attempt++) {
    try {
      await db.execute({
        sql: "UPDATE inbox_send_job SET status = ?, error = ?, finished_at = ?, accept_ms = ?, bison_ms = ?, total_ms = ? WHERE id = ?",
        args: [outcome.ok ? "sent" : "failed", outcome.ok ? null : (outcome.error || "Send failed").slice(0, 1000),
          new Date().toISOString(), timings.acceptMs, timings.bisonMs, timings.totalMs, id],
      });
      return;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

/** Where these sends stand — only the caller's own. A send left unfinished too long reads "unknown". */
export async function sendJobStatuses(ids: string[], by: string | null): Promise<{ id: string; status: SendJobStatus; error: string | null }[]> {
  const list = [...new Set(ids.filter((x) => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 20);
  if (!list.length) return [];
  await ensureTable();
  const r = await db.execute({
    sql: `SELECT id, status, error, created_at FROM inbox_send_job WHERE id IN (${list.map(() => "?").join(",")}) AND by_email IS ?`,
    args: [...list, by],
  });
  const cutoff = Date.now() - STALE_MS;
  return r.rows.map((row) => {
    const status = String(row.status) as SendJobStatus;
    const stale = status === "sending" && new Date(String(row.created_at)).getTime() < cutoff;
    return {
      id: String(row.id),
      status: stale ? "unknown" : status,
      error: stale ? "This send never reported back." : ((row.error as string | null) ?? null),
    };
  });
}
