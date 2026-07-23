/**
 * GET /api/archive — search the Archived Database (ReplyRouter spec §2).
 *
 * Searches ONLY archived rows (archived = true) by any of: client tag, contact
 * name, email, lead category, AI category, date range, and reply content.
 * Paginated. Admin/auth-gated with the same per-user client scoping as the inbox.
 * Viewing/editing/restoring reuse /api/inbox/[id] + /api/inbox/mutate.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SELECT =
  "id, workflow, lead_email, lead_name, first_name, last_name, company_name, client_tag, bison_instance, ai_categorized_lead_category, lead_category, reply_status, created_at, reply_time, archived_at, reply_id";
const PAGE = 100;

// Safe before the archiving migration runs: no `archived` column → empty result.
let _archivedCol: boolean | null = null;
async function hasArchivedColumn(): Promise<boolean> {
  if (_archivedCol !== null) return _archivedCol;
  const { error } = await supabase.from("replies").select("id").eq("archived", true).limit(1);
  _archivedCol = !error;
  return _archivedCol;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await hasArchivedColumn())) return NextResponse.json({ rows: [], page: { hasMore: false } });

  const allowed = session.allowedClientTags ?? null;
  const sp = req.nextUrl.searchParams;
  const search = (sp.get("search") || "").trim();
  const reqTag = sp.get("client_tag");
  const leadCategory = sp.get("lead_category");
  const aiCategory = sp.get("ai_category");
  const from = sp.get("from"); // YYYY-MM-DD
  const to = sp.get("to");
  const offset = Math.max(0, Number(sp.get("offset") || 0));

  let clientTag = reqTag;
  if (allowed && allowed.length && clientTag && !allowed.includes(clientTag)) clientTag = allowed[0];

  try {
    let q = supabase
      .from("replies")
      .select(SELECT)
      .eq("archived", true)
      .order("archived_at", { ascending: false, nullsFirst: false })
      .range(offset, offset + PAGE - 1);
    if (clientTag) q = q.eq("client_tag", clientTag);
    else if (allowed && allowed.length) q = q.in("client_tag", allowed);
    if (leadCategory) q = q.eq("lead_category", leadCategory);
    if (aiCategory) q = q.eq("ai_categorized_lead_category", aiCategory);
    if (from) q = q.gte("created_at", `${from}T00:00:00Z`);
    if (to) q = q.lte("created_at", `${to}T23:59:59Z`);
    if (search) {
      const s = search.replace(/[%,]/g, " ");
      q = q.or(
        `lead_email.ilike.%${s}%,company_name.ilike.%${s}%,lead_name.ilike.%${s}%,reply_we_got.ilike.%${s}%`
      );
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const returned = rows?.length || 0;
    return NextResponse.json({ rows: rows || [], page: { offset, returned, hasMore: returned === PAGE } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
