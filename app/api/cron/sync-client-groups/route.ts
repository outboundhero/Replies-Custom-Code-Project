/**
 * GET /api/cron/sync-client-groups?secret=X
 *
 * Reads the instance-mapping sheet (Sheet1: col A = Group-1 tags, col C =
 * Group-2 tags) and replaces the Turso `client_groups` table. Nurture routing
 * (lib/nurture/group-routing.ts) reads it to send each client's leads to its
 * group's B2B/B2C Bison instance.
 *
 * Wire to a daily Vercel cron; also callable manually after the sheet changes.
 */
import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { fetchClientGroups } from "@/lib/google-sheets";
import { invalidateGroupCache } from "@/lib/nurture/group-routing";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let groups: Map<string, 1 | 2>;
  try {
    groups = await fetchClientGroups();
  } catch (e) {
    return NextResponse.json({ error: `sheet read failed: ${(e as Error).message}` }, { status: 502 });
  }

  await db.execute(
    "CREATE TABLE IF NOT EXISTS client_groups (client_tag TEXT PRIMARY KEY, group_num INTEGER NOT NULL, synced_at TEXT)",
  );
  const now = new Date().toISOString();
  await db.execute("DELETE FROM client_groups");
  const entries = [...groups.entries()];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    await db.batch(
      chunk.map(([tag, g]) => ({
        sql: "INSERT OR REPLACE INTO client_groups (client_tag, group_num, synced_at) VALUES (?, ?, ?)",
        args: [tag, g, now],
      })),
      "write",
    );
  }
  invalidateGroupCache();

  const group1 = entries.filter(([, g]) => g === 1).map(([t]) => t).sort();
  const group2 = entries.filter(([, g]) => g === 2).map(([t]) => t).sort();
  return NextResponse.json({ ok: true, count: groups.size, group1: group1.length, group2: group2.length, sampleG1: group1.slice(0, 5), sampleG2: group2.slice(0, 5) });
}
