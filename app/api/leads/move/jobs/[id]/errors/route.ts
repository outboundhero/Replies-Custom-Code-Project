/**
 * GET /api/leads/move/jobs/[id]/errors
 *
 * "Why?" for a move: the leads that didn't reach their campaign, grouped by
 * reason with a few example emails. `?format=csv` downloads every one of them
 * (client, source campaign, email, reason, status, attempts). Signed-in users.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getJobErrors, getJobErrorRows } from "@/lib/leads/move-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const COLUMNS = ["client_tag", "source_campaign_name", "email", "ob_lead_id", "reason", "status", "attempts", "updated_at"] as const;
function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth();
  if (denied) return denied;
  const { id } = await params;

  if (req.nextUrl.searchParams.get("format") !== "csv") {
    try {
      return NextResponse.json({ groups: await getJobErrors(id) });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(enc.encode(COLUMNS.join(",") + "\n"));
        let after = 0;
        for (;;) {
          const rows = await getJobErrorRows(id, after, 2000);
          if (!rows.length) break;
          controller.enqueue(enc.encode(rows.map((r) => COLUMNS.map((c) => csvEscape(r[c])).join(",")).join("\n") + "\n"));
          after = Number(rows[rows.length - 1].rid);
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="move-errors-${id.slice(0, 8)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
