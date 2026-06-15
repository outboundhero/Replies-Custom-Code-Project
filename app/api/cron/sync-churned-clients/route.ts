/**
 * GET /api/cron/sync-churned-clients?secret=X
 *
 * Reads the Client Tracker sheet, computes the churned set (Status="Churned"
 * AND a Churn Date), and replaces the Turso `churned_clients` table. The
 * nurture page + workflows read it via lib/churn.ts to skip churned clients.
 *
 * Wire to a daily-ish Vercel cron; also callable manually after the sheet
 * changes.
 */
import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { fetchChurnedClientTags } from "@/lib/google-sheets";
import { invalidateChurnCache } from "@/lib/churn";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let tags: Set<string>;
  try {
    tags = await fetchChurnedClientTags();
  } catch (e) {
    return NextResponse.json({ error: `sheet read failed: ${(e as Error).message}` }, { status: 502 });
  }

  await db.execute(
    "CREATE TABLE IF NOT EXISTS churned_clients (client_tag TEXT PRIMARY KEY, synced_at TEXT)",
  );
  const now = new Date().toISOString();
  // Replace the whole set (a client can un-churn).
  await db.execute("DELETE FROM churned_clients");
  for (const tag of tags) {
    await db.execute({ sql: "INSERT OR IGNORE INTO churned_clients (client_tag, synced_at) VALUES (?, ?)", args: [tag, now] });
  }
  invalidateChurnCache();

  return NextResponse.json({ ok: true, churned: tags.size, tags: [...tags].sort() });
}
