/**
 * POST /api/nurture/queue/remove
 *   { tag, emails: string[] }                                   → remove these contacts
 *   { tag, all: true, expected: n, ...filters (search/email/web/source/tld/overlap) } → every match
 * "Remove" = the existing nurture skip flag on exactly the contact's queue rows
 * (reversible via /restore; nothing changes in Bison). Each removal is recorded
 * in Turso (pending → done) with the exact row ids it flagged, so Undo restores
 * precisely those rows. "All matching" is re-counted first and refused if the
 * set changed since the user confirmed it, and capped per operation.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";
import db from "@/lib/db";
import { activeClientTags, markTagStatsDirty } from "@/lib/nurture/overview";
import { parseQueueFilters, toRpcArgs } from "@/lib/nurture/queue-filters";
import { ensureRemovalsTable } from "@/lib/nurture/queue-removals";
import { logActivity } from "@/lib/errors";

export const maxDuration = 300;

const MAX_BULK = 20_000;

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const rawTag = String(body?.tag || "").trim();
  if (!rawTag) return NextResponse.json({ error: "tag required" }, { status: 400 });
  const all = body?.all === true;
  const emails: string[] = Array.isArray(body?.emails)
    ? [...new Set(body.emails.map((e: unknown) => String(e || "").trim().toLowerCase()).filter(Boolean))].slice(0, 5000) as string[]
    : [];
  if (!all && emails.length === 0) return NextResponse.json({ error: "emails or all:true required" }, { status: 400 });

  try {
    const { tags: active, churned } = await activeClientTags();
    const tag = active.find((t) => t.toUpperCase() === rawTag.toUpperCase());
    if (!tag) return NextResponse.json({ error: `${rawTag} isn't an active client.` }, { status: 404 });
    const filters = parseQueueFilters(body || {});

    // "All matching": confirm the set is what the user saw, and bounded.
    if (all) {
      const { data, error } = await supabase.rpc("nurture_queue_page", {
        p_tag: tag, ...toRpcArgs(filters), p_ignore_tags: churned, p_limit: 1, p_offset: 0,
      });
      if (error) throw new Error(error.message);
      const total = data?.length ? Number(data[0].total_count) : 0;
      if (total === 0) return NextResponse.json({ ok: true, contacts: 0, rows: 0, removalId: null, undoable: false });
      if (total > MAX_BULK) {
        return NextResponse.json({ error: `That's ${total.toLocaleString()} contacts — narrow the filters (max ${MAX_BULK.toLocaleString()} per removal).`, total }, { status: 400 });
      }
      const expected = Number(body?.expected);
      if (Number.isFinite(expected) && Math.abs(total - expected) > Math.max(5, Math.round(expected * 0.02))) {
        return NextResponse.json({ error: `The matching set changed (now ${total.toLocaleString()} contacts) — review it and confirm again.`, total }, { status: 409 });
      }
    }

    // Record first (pending), so the change can never exist without a record.
    const session = await getSession();
    await ensureRemovalsTable();
    const ins = await db.execute({
      sql: `INSERT INTO nurture_queue_removals (client_tag, removed_at, removed_by, mode, filters_json, status)
            VALUES (?, ?, ?, ?, ?, 'pending') RETURNING id`,
      args: [tag, new Date().toISOString(), session?.email ?? null, all ? "all-matching" : "selected", all ? JSON.stringify(filters) : JSON.stringify({ emails: emails.slice(0, 50) })],
    });
    const removalId = Number(ins.rows[0]?.id);

    const { data, error } = await supabase.rpc("nurture_queue_remove", {
      p_tag: tag, p_emails: all ? null : emails, p_all_matching: all, ...toRpcArgs(filters), p_ignore_tags: churned,
    });
    if (error) {
      await db.execute({ sql: "UPDATE nurture_queue_removals SET status = 'failed', error = ? WHERE id = ?", args: [error.message.slice(0, 300), removalId] });
      throw new Error(error.message);
    }
    const contacts = Number(data?.contacts ?? 0), rows = Number(data?.rows ?? 0);
    // Exact row ids → precise Undo. (A database not yet on patch 1 returns none:
    // such a removal is recorded but can't be undone automatically.)
    const ids = Array.isArray(data?.reply_ids)
      ? { reply: data.reply_ids as number[], seq: data.seq_ids as number[], legacy: data.legacy_ids as number[] }
      : null;
    await db.execute({
      sql: "UPDATE nurture_queue_removals SET status = 'done', contacts = ?, row_count = ?, ids_json = ?, emails_json = ? WHERE id = ?",
      args: [contacts, rows, ids ? JSON.stringify(ids) : null, Array.isArray(data?.emails) ? JSON.stringify(data.emails) : null, removalId],
    });

    if (rows > 0) await markTagStatsDirty(tag); // the next stats run (≤10 min) picks it up first
    await logActivity("nurture", "queue-remove", {
      client_tag: tag,
      details: { by: session?.email, removal_id: removalId, contacts, rows, mode: all ? "all-matching" : "selected", filters: all ? filters : undefined, sample: (data?.emails || []).slice(0, 20) },
    });
    return NextResponse.json({ ok: true, contacts, rows, removalId, undoable: !!ids && rows > 0 });
  } catch (e) {
    console.error("[api/nurture/queue/remove]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
