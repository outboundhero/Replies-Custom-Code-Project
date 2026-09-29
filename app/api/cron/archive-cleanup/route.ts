/**
 * GET /api/cron/archive-cleanup
 *
 * Archives replies that have been OUT of Open Response for > 15 days, keeping
 * the active inbox small so exact counts stay fast (ReplyRouter spec §3).
 * Open Response is never archived. Restored replies re-enter Open Response and
 * restart the clock (see the mutate `restore` action).
 *
 * Runs every other Friday ~10pm PT. Vercel crons are UTC with no bi-weekly
 * primitive, so vercel.json fires it weekly (Sat 05:00 UTC ≈ Fri 10pm PT) and
 * we skip odd weeks in code. Only rows with a `categorized_at` older than the
 * cutoff are touched — historical rows without it are handled by the one-time
 * initial backfill in sql/2026-07_archiving.sql.
 *
 * Auth: CRON_SECRET (Bearer / x-cron-secret / ?secret).
 */
import { NextRequest, NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { logActivity, logError } from "@/lib/errors";
import { bumpCacheVersion } from "@/lib/inbox-cache";

export const maxDuration = 120;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Bi-weekly: run only on even week numbers (unless ?force=1 for a manual run).
  const force = req.nextUrl.searchParams.get("force") === "1";
  const weekNo = Math.floor(Date.now() / WEEK_MS);
  if (!force && weekNo % 2 !== 0) {
    return NextResponse.json({ ok: true, skipped: "odd week (bi-weekly cadence)" });
  }

  const cutoff = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  // One UPDATE over every eligible row hit Postgres's statement timeout once the
  // backlog grew (~17k rows) — and a timed-out run archives NOTHING, so the
  // backlog only kept growing. Archive in id batches instead, within a time
  // budget; whatever's left is picked up by the next run.
  const BATCH = 1000;
  const budgetMs = 100_000;
  const started = Date.now();
  const archivedAt = new Date().toISOString();
  let archived = 0;
  let done = false;
  try {
    while (Date.now() - started < budgetMs) {
      const { data: batch, error: selErr } = await supabase
        .from("replies")
        .select("id")
        .eq("archived", false)
        .neq("lead_category", "Open Response")
        .lt("categorized_at", cutoff) // NULLs excluded automatically (never timed → skip)
        .limit(BATCH);
      if (selErr) throw new Error(selErr.message);
      const ids = (batch || []).map((r) => r.id as number);
      if (!ids.length) { done = true; break; }
      const { error: updErr } = await supabase
        .from("replies")
        .update({ archived: true, archived_at: archivedAt })
        .in("id", ids);
      if (updErr) throw new Error(updErr.message);
      archived += ids.length;
      if (ids.length < BATCH) { done = true; break; }
    }
    if (archived > 0) bumpCacheVersion();
    await logActivity("archive-cleanup", "archived", { details: { archived, cutoff, complete: done } });
    return NextResponse.json({ ok: true, archived, complete: done });
  } catch (e) {
    if (archived > 0) bumpCacheVersion(); // earlier batches did land
    await logError("archive-cleanup", "run", (e as Error).message, { cutoff, archivedBeforeError: archived });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
