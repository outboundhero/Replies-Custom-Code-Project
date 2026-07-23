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
  try {
    const { data, error } = await supabase
      .from("replies")
      .update({ archived: true, archived_at: new Date().toISOString() })
      .eq("archived", false)
      .neq("lead_category", "Open Response")
      .lt("categorized_at", cutoff) // NULLs excluded automatically (never timed → skip)
      .select("id");
    if (error) throw new Error(error.message);
    const archived = data?.length ?? 0;
    if (archived > 0) bumpCacheVersion();
    await logActivity("archive-cleanup", "archived", { details: { archived, cutoff } });
    return NextResponse.json({ ok: true, archived });
  } catch (e) {
    await logError("archive-cleanup", "run", (e as Error).message, { cutoff });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
