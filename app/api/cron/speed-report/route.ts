/**
 * GET /api/cron/speed-report — Speed-to-Lead Slack reports (spec §10–§12).
 *
 * Daily (every day 5:00 PM PT): posts to #inbox-management-team, starts with ⚡,
 * tags no one. Metrics over POSITIVE categories only (§10): Meeting-Ready Lead,
 * Follow Up, Interested, Referral Given (+ legacy "Meeting Ready Lead"):
 *   - average speed-to-lead for the day
 *   - % completed within the 15-minute standard
 *   - number of positive leads categorized
 *
 * Fridays: also posts the WEEKLY report (last 7 PT days) to the channel and
 * DMs the weekly lead-delivery roundup (leads delivered + the same metrics)
 * to the people in SLACK_ROUNDUP_EMAILS (Spencer / Madison / Nick).
 *
 * Vercel crons are UTC; 5pm PT is 00:00 UTC (PDT) or 01:00 UTC (PST), so
 * vercel.json fires both hours and we run only when it's actually 17:00 PT,
 * with a Turso cron_state key so a day never double-sends.
 *
 * Auth: CRON_SECRET (Bearer / x-cron-secret / ?secret). ?force=1 skips the
 * time gate for manual testing; ?dry=1 computes without posting.
 */
import { NextRequest, NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import db from "@/lib/db";
import { postToChannel, dmByEmails } from "@/lib/slack";
import { logActivity, logError } from "@/lib/errors";

export const maxDuration = 60;

const POSITIVE = ["Meeting-Ready Lead", "Meeting Ready Lead", "Follow Up", "Interested", "Referral Given"];
const STANDARD_SECS = 15 * 60;

interface Metrics { count: number; avgSecs: number | null; pctWithin: number | null }

function fmtDur(secs: number): string {
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  if (m === 0) return `${s} seconds`;
  return `${m} minute${m === 1 ? "" : "s"}, ${s} second${s === 1 ? "" : "s"}`;
}

/** PT calendar date parts for a given instant. */
function ptParts(d: Date): { y: number; m: number; day: number; hour: number; weekday: string; iso: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const y = Number(get("year")), m = Number(get("month")), day = Number(get("day"));
  return { y, m, day, hour: Number(get("hour")) % 24, weekday: get("weekday"), iso: `${get("year")}-${get("month")}-${get("day")}` };
}

/** UTC instant for midnight PT on the given PT calendar date (DST-correct). */
function ptMidnightUtc(y: number, m: number, day: number): Date {
  // Guess UTC-8, then correct by whatever PT clock the guess lands on.
  const guess = new Date(Date.UTC(y, m - 1, day, 8));
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", hour12: false }).format(guess)) % 24;
  return new Date(guess.getTime() - h * 3600_000);
}

async function metricsBetween(startIso: string, endIso: string): Promise<Metrics> {
  const { data, error } = await supabase
    .from("replies")
    .select("time_to_categorize_seconds")
    .in("lead_category", POSITIVE)
    .gte("categorized_at", startIso)
    .lt("categorized_at", endIso)
    .limit(10000);
  if (error) throw new Error(error.message);
  const rows = (data || []) as { time_to_categorize_seconds: number | null }[];
  const count = rows.length;
  const timed = rows.map((r) => r.time_to_categorize_seconds).filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  const avgSecs = timed.length ? timed.reduce((a, b) => a + b, 0) / timed.length : null;
  const pctWithin = timed.length ? Math.round((timed.filter((s) => s <= STANDARD_SECS).length / timed.length) * 100) : null;
  return { count, avgSecs, pctWithin };
}

function reportText(title: string, m: Metrics): string {
  return [
    `⚡ ${title}`,
    `Average speed-to-lead: ${m.avgSecs != null ? fmtDur(m.avgSecs) : "—"}`,
    `Within 15-minute standard: ${m.pctWithin != null ? `${m.pctWithin}%` : "—"}`,
    `Positive leads handled: ${m.count}`,
  ].join("\n");
}

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const force = req.nextUrl.searchParams.get("force") === "1";
  const dry = req.nextUrl.searchParams.get("dry") === "1";

  const now = new Date();
  const pt = ptParts(now);
  // Only run at 5 PM PT (the UTC schedule fires at both possible offsets).
  if (!force && pt.hour !== 17) {
    return NextResponse.json({ ok: true, skipped: `PT hour is ${pt.hour}, waiting for 17:00` });
  }

  try {
    // Dedupe: one send per PT day.
    const stateKey = `speed-report:${pt.iso}`;
    if (!force && !dry) {
      await db.execute("CREATE TABLE IF NOT EXISTS cron_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
      const seen = await db.execute({ sql: "SELECT value FROM cron_state WHERE key = ?", args: [stateKey] });
      if (seen.rows.length) return NextResponse.json({ ok: true, skipped: "already sent today" });
    }

    const channel = process.env.SLACK_SPEED_REPORT_CHANNEL || "#inbox-management-team";
    const dayStart = ptMidnightUtc(pt.y, pt.m, pt.day);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);

    // ── Daily report (§11) ──
    const daily = await metricsBetween(dayStart.toISOString(), dayEnd.toISOString());
    const dailyText = reportText("Daily Speed-to-Lead Report", daily);

    // ── Weekly report + roundup on Fridays (§12) ──
    const isFriday = pt.weekday === "Fri";
    let weekly: Metrics | null = null;
    let weeklyText: string | null = null;
    if (isFriday) {
      const weekStart = new Date(dayEnd.getTime() - 7 * 24 * 3600_000);
      weekly = await metricsBetween(weekStart.toISOString(), dayEnd.toISOString());
      weeklyText = reportText("Weekly Speed-to-Lead Report", weekly);
    }

    if (dry) {
      return NextResponse.json({ ok: true, dry: true, dailyText, weeklyText });
    }

    const results: Record<string, unknown> = {};
    const post1 = await postToChannel(channel, dailyText);
    results.daily = post1;
    if (!post1.ok) throw new Error(`daily post failed: ${post1.error}`);

    if (isFriday && weeklyText && weekly) {
      const post2 = await postToChannel(channel, weeklyText);
      results.weekly = post2;
      // Weekly lead-delivery roundup DM (leads delivered + the metrics).
      const emails = (process.env.SLACK_ROUNDUP_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (emails.length) {
        const roundup = [
          `⚡ Weekly Lead Delivery Roundup`,
          `Leads delivered this week: ${weekly.count}`,
          `Average speed-to-lead: ${weekly.avgSecs != null ? fmtDur(weekly.avgSecs) : "—"}`,
          `Within 15-minute standard: ${weekly.pctWithin != null ? `${weekly.pctWithin}%` : "—"}`,
        ].join("\n");
        results.roundup = await dmByEmails(emails, roundup);
      } else {
        results.roundup = { ok: false, error: "SLACK_ROUNDUP_EMAILS not configured" };
      }
    }

    await db.execute({
      sql: "INSERT INTO cron_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      args: [stateKey, "sent", new Date().toISOString()],
    });
    await logActivity("speed-report", "sent", { details: { day: pt.iso, daily, weekly } });
    return NextResponse.json({ ok: true, ...results });
  } catch (e) {
    await logError("speed-report", "run", (e as Error).message, { day: pt.iso });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
