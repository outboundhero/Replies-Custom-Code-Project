/**
 * GET /api/leads/move/skipped/export?runId=…&clientTag=…
 *
 * Streams the service-area-skipped leads as a CSV download, with EVERY Bison
 * detail (standard fields + city/state + reason + source campaign + the full
 * custom_variables JSON). Paged read + streamed response so a large export
 * never exhausts memory or Turso's response-size limit.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import db from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const COLUMNS = [
  "client_tag", "email", "first_name", "last_name", "company", "city", "state",
  "reason", "source_campaign_name", "source_instance", "target_instance",
  "ob_lead_id", "skipped_at", "custom_variables",
] as const;

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const runId = req.nextUrl.searchParams.get("runId");
  const clientTag = req.nextUrl.searchParams.get("clientTag");

  const conditions: string[] = [];
  const baseArgs: (string | number)[] = [];
  if (runId) { conditions.push("run_id = ?"); baseArgs.push(runId); }
  if (clientTag) { conditions.push("client_tag = ?"); baseArgs.push(clientTag.toUpperCase()); }
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";

  const PAGE = 2000;
  const encoder = new TextEncoder();
  const header = COLUMNS.map((c) => (c === "custom_variables" ? "custom_variables_json" : c)).join(",") + "\n";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(header));
      let offset = 0;
      try {
        for (;;) {
          const res = await db.execute({
            sql: `SELECT ${COLUMNS.join(", ")} FROM lead_move_skipped${where}
                  ORDER BY skipped_at DESC LIMIT ? OFFSET ?`,
            args: [...baseArgs, PAGE, offset],
          });
          if (!res.rows.length) break;
          let buf = "";
          for (const row of res.rows) {
            buf += COLUMNS.map((c) => csvEscape((row as Record<string, unknown>)[c])).join(",") + "\n";
          }
          controller.enqueue(encoder.encode(buf));
          if (res.rows.length < PAGE) break;
          offset += PAGE;
        }
      } catch {
        controller.enqueue(encoder.encode("\n# export interrupted by a read error\n"));
      }
      controller.close();
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const name = `skipped-leads${clientTag ? `-${clientTag.toUpperCase()}` : ""}-${stamp}.csv`;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
