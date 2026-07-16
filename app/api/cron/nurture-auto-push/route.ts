/**
 * GET /api/cron/nurture-auto-push
 *
 * The "completely automate nurture" cron. For every client that has
 * auto-push enabled (typically because they clicked the Auto-route
 * button at least once), this runs the same auto-route logic the UI
 * does: pull newly-eligible Ready leads, partition by ESP, push each
 * bucket to its canonical Bison campaign, stamp added_at + log.
 *
 * Schedule: every 2 hours (vercel.json). Per-client wall-clock budget
 * keeps each tick comfortably inside the 5-min route limit even with
 * many enabled clients.
 *
 * Auth: same CRON_SECRET pattern as the other cron jobs.
 */

import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { listAutoEnabledClients, runAutoPushForClient } from "@/lib/nurture/auto-push";
import { autoActivateReadyCampaigns } from "@/lib/nurture/enable-sending";
import { logActivity, logError } from "@/lib/errors";

export const maxDuration = 300;

const SOFT_BUDGET_MS = 4.5 * 60 * 1000; // 270s — leaves 30s for log/return

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const allTags = await listAutoEnabledClients();

  // FAIR ROTATION — the 270s budget only covers ~15 clients/tick, but there are
  // far more enabled. Without rotation the loop restarts from the top every tick,
  // so the same first ~15 clients get served and everyone later (e.g. #76) starves.
  // Resume AFTER the last tag we processed and wrap around, so every client gets a
  // turn across ticks.
  const CURSOR_KEY = "nurture-auto-push:cursor";
  let cursor: string | null = null;
  try {
    await db.execute("CREATE TABLE IF NOT EXISTS cron_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
    const c = await db.execute({ sql: "SELECT value FROM cron_state WHERE key=?", args: [CURSOR_KEY] });
    cursor = (c.rows[0]?.value as string) ?? null;
  } catch { /* first run / table missing → start from the top */ }
  let start = 0;
  if (cursor) { const i = allTags.indexOf(cursor); if (i >= 0) start = (i + 1) % allTags.length; }
  const tags = start ? [...allTags.slice(start), ...allTags.slice(0, start)] : allTags;
  let lastProcessed: string | null = null;

  const summary: Array<{ tag: string; scanned: number; attached: number; buckets: number; errors: number; activated?: number }> = [];
  // Auto-activate mapped campaigns once senders + leads are ready (kill-switch:
  // set NURTURE_AUTO_ACTIVATE=off to disable). Runs per client after its push.
  const autoActivateOn = process.env.NURTURE_AUTO_ACTIVATE !== "off";

  const PER_CLIENT_PAGES = 60;   // page past up to ~12k scanned/client/tick so an
                                 // unmappable-lane backlog can't block newer leads
  const PER_CLIENT_ATTACH = 1000; // but bound actual attach work per client/tick

  // Process clients sequentially. Bison API rate-limits per token, so
  // running them in parallel would just thrash the limit. The wall-
  // clock budget below stops us before the 5-min route ceiling.
  for (const tag of tags) {
    if (Date.now() - startedAt > SOFT_BUDGET_MS) {
      await logActivity("nurture-auto-push", "soft-budget-hit", {
        details: {
          processed: summary.length,
          remaining: tags.length - summary.length,
          message: "Soft budget hit — remaining clients will be picked up on the next tick.",
        },
      });
      break;
    }
    // Page through this client with id cursors so unmappable-lane leads
    // (e.g. B2C when only B2B is mapped) are scanned-and-skipped, never jamming
    // the window. Bounded per tick by pages, attach count, and the soft budget.
    let seqAfterId = 0, repAfterId = 0, legAfterId = 0, scanned = 0, attached = 0, buckets = 0, errors = 0;
    try {
      for (let page = 0; page < PER_CLIENT_PAGES; page++) {
        if (Date.now() - startedAt > SOFT_BUDGET_MS) break;
        const r = await runAutoPushForClient(tag, { seqAfterId, repAfterId, legAfterId });
        scanned += r.scanned;
        attached += r.totalAttached;
        buckets = Math.max(buckets, r.perBucket.length);
        errors += r.perBucket.filter((b) => b.error).length + (r.error ? 1 : 0);
        seqAfterId = r.nextSeqAfterId;
        repAfterId = r.nextRepAfterId;
        legAfterId = r.nextLegAfterId;
        if (r.error || r.exhausted || attached >= PER_CLIENT_ATTACH) break;
      }
      // Once this tick's ready leads are routed, activate any mapped campaign
      // that now has connected senders + leads (guarded inside the helper).
      let activated = 0;
      if (autoActivateOn) {
        try { activated = (await autoActivateReadyCampaigns(tag)).activated.length; }
        catch (e) { await logError("nurture-auto-push", `auto-activate:${tag}`, (e as Error).message); }
      }
      summary.push({ tag, scanned, attached, buckets, errors, activated });
    } catch (e) {
      await logError("nurture-auto-push", `fatal:${tag}`, (e as Error).message);
      summary.push({ tag, scanned, attached, buckets, errors: errors + 1 });
    }
    lastProcessed = tag; // advance the rotation cursor past every client we considered
  }

  // Persist where we stopped so the next tick resumes after it (wrapping around).
  if (lastProcessed) {
    try {
      await db.execute({
        sql: "INSERT INTO cron_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        args: [CURSOR_KEY, lastProcessed, new Date().toISOString()],
      });
    } catch { /* cursor persist is best-effort */ }
  }

  await logActivity("nurture-auto-push", "completed", {
    details: {
      clients_processed: summary.length,
      total_enabled: allTags.length,
      resumed_after: cursor,
      stopped_at: lastProcessed,
      total_attached: summary.reduce((s, x) => s + x.attached, 0),
      summary,
    },
  });

  return NextResponse.json({ ok: true, processed: summary.length, summary });
}
