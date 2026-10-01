/**
 * GET /api/cron/ccg-zip-audit
 *
 * Catch-up for the CCG ZIP audit (lib/qualification/zip-audit.ts). qualifyLead
 * runs it for tracked replies, but untracked replies never go through
 * qualifyLead and the audit-pending cron skips "Follow Up at a Later Date" /
 * "Unrecognizable by AI". This picks up any CCG positive lead from the last 30
 * days that has no zip_audit row yet. A few per run, within a time budget.
 *
 * Auth: CRON_SECRET (Bearer / x-cron-secret / ?secret).
 */
import { NextRequest, NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import db from "@/lib/db";
import { logError } from "@/lib/errors";
import { ensureZipAuditTable, loadCcgZipIndex, runCcgZipAudit } from "@/lib/qualification/zip-audit";

export const maxDuration = 300;

const CATEGORIES = ["Interested", "Meeting Request", "Follow Up at a Later Date", "Referral Given", "Unrecognizable by AI"];
const PER_RUN = 20;
const BUDGET_MS = 240_000;

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  await ensureZipAuditTable();
  const idx = await loadCcgZipIndex();
  const tags = [...idx.zipsByTag.keys(), ...idx.noZipList];
  if (!tags.length) return NextResponse.json({ ok: true, audited: 0, note: "no active CCG tags" });

  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data, error } = await supabase
    .from("replies")
    .select("id, client_tag, company_name, city, state, address, google_maps_url, phone, lead_email, reply_we_got")
    .in("client_tag", tags)
    .in("ai_categorized_lead_category", CATEGORIES)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(400);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (data || []).map((r) => r.id as number);
  const done = new Set<number>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    if (!chunk.length) break;
    const r = await db.execute({ sql: `SELECT reply_row_id, client_tag, verdict FROM zip_audit WHERE reply_row_id IN (${chunk.map(() => "?").join(",")})`, args: chunk });
    for (const row of r.rows as unknown as Array<{ reply_row_id: number; client_tag: string; verdict: string }>) {
      // "No ZIP list" is only final while the client still has no list — once
      // ZIPs are added to its Inclusion locations cell, audit those leads again.
      const nowHasList = row.verdict === "No ZIP list" && idx.zipsByTag.has(String(row.client_tag).toUpperCase());
      if (!nowHasList) done.add(Number(row.reply_row_id));
    }
  }
  const todo = (data || []).filter((r) => !done.has(r.id as number)).slice(0, PER_RUN);

  let audited = 0, failed = 0, i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < todo.length && Date.now() - started < BUDGET_MS) {
      const r = todo[i++];
      try {
        await runCcgZipAudit(r.id as number, String(r.client_tag), {
          replyText: String(r.reply_we_got || ""), companyName: r.company_name, leadEmail: r.lead_email,
          crmAddress: r.address, crmCity: r.city, crmState: r.state, googleMapsUrl: r.google_maps_url, phone: String(r.phone || ""),
        });
        audited++;
      } catch (e) {
        failed++;
        await logError("ccg-zip-audit", `row ${r.id}`, (e as Error).message);
      }
    }
  }));
  return NextResponse.json({ ok: true, candidates: todo.length, audited, failed, remaining: Math.max(0, (data || []).length - done.size - audited) });
}
