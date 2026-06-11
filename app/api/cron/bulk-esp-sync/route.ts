/**
 * GET /api/cron/bulk-esp-sync
 *
 * Fast ESP re-derive. Instead of one Bison lead-search per lead (slow), this
 * pages Bison's /api/leads list (100 leads + tags per call) and overwrites
 * the `esp` column on our nurture tables in place via pickEspFromTags(). No
 * nulling, so no "held" leads. ~100x fewer Bison calls than the per-lead
 * backfill.
 *
 * Query params:
 *   secret    must match CRON_SECRET
 *   instance  bison instance key (default outboundhero)
 *   page      first page to fetch (default 1)
 *   pages     how many pages this call fetches (default 20, max 40)
 *   dry       "1" to skip DB writes (probe tags/counts only)
 *
 * Response includes lastPage so the caller can loop: page += pages until
 * page > lastPage.
 */
import { NextRequest, NextResponse } from "next/server";
import supabase from "@/lib/supabase";
import { getInstanceConfig } from "@/lib/bison-instances";
import { pickEspFromTags } from "@/lib/nurture/esp";

export const maxDuration = 300;

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function GET(req: NextRequest) {
  const secret =
    req.headers.get("x-cron-secret") ||
    req.nextUrl.searchParams.get("secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const instance = req.nextUrl.searchParams.get("instance") || "outboundhero";
  const startPage = Math.max(1, Number(req.nextUrl.searchParams.get("page") || 1));
  const pages = Math.min(40, Math.max(1, Number(req.nextUrl.searchParams.get("pages") || 20)));
  const dry = req.nextUrl.searchParams.get("dry") === "1";

  let baseUrl: string, token: string;
  try { ({ baseUrl, token } = getInstanceConfig(instance)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };

  let lastPage = startPage;
  let leadsSeen = 0, withEsp = 0, withTagsField = 0;
  const byEsp = new Map<string, Set<string>>(); // esp -> emails (orig + lower)
  let sampleLead: unknown = null;

  try {
    for (let p = startPage; p < startPage + pages; p++) {
      const res = await fetch(`${baseUrl}/api/leads?page=${p}&per_page=100`, { headers });
      if (!res.ok) {
        return NextResponse.json({ error: `Bison /api/leads page ${p} -> ${res.status}`, body: (await res.text()).slice(0, 200) }, { status: 502 });
      }
      const data = await res.json();
      const rows: Array<{ email?: string; tags?: Array<{ id: number; name: string; default?: boolean }> }> = data?.data || [];
      lastPage = (data?.meta?.last_page as number | undefined) ?? p;
      if (!sampleLead && rows[0]) sampleLead = { email: rows[0].email, tags: rows[0].tags };
      for (const lead of rows) {
        leadsSeen++;
        if (Array.isArray(lead.tags)) withTagsField++;
        const raw = (lead.email || "").trim();
        if (!raw) continue;
        const esp = pickEspFromTags(lead.tags);
        if (!esp) continue;
        withEsp++;
        if (!byEsp.has(esp)) byEsp.set(esp, new Set());
        const set = byEsp.get(esp)!;
        set.add(raw);
        set.add(raw.toLowerCase());
      }
      if (p >= lastPage || rows.length === 0) break;
    }

    const updated: Record<string, number> = { seq: 0, legacy: 0 };
    if (!dry) {
      for (const [esp, emailSet] of byEsp) {
        const emails = [...emailSet];
        for (const c of chunk(emails, 200)) {
          const r1 = await supabase.from("nurture_sequence_finished").update({ esp }).in("email", c).select("id");
          const r2 = await supabase.from("nurture_legacy_leads").update({ esp }).in("lead_email", c).select("id");
          updated.seq += r1.data?.length || 0;
          updated.legacy += r2.data?.length || 0;
        }
      }
    }

    const nextPage = startPage + pages;
    return NextResponse.json({
      ok: true, instance, startPage, pagesRequested: pages, lastPage,
      leadsSeen, withTagsField, withEsp, espBuckets: [...byEsp.keys()],
      updated, dry, nextPage: nextPage > lastPage ? null : nextPage, sampleLead,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, leadsSeen, withEsp }, { status: 500 });
  }
}
