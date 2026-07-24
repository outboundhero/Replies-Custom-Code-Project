import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";

// Airtable-style Data View feed (spec §13): a FLAT, paginated, filterable,
// sortable list over the ACTIVE inbox (archived rows excluded), carrying the
// full From/To/CC/BCC recipients (§6) so the table + bulk-review cards can show
// everyone on the thread. Kept separate from /api/inbox (which is grouped by
// category + heavily cached) so this stays simple and predictable.

export const maxDuration = 60;

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// Full recipients + content for §6 visibility and the review-queue cards.
const SELECT =
  "id, reply_id, workflow, client_tag, bison_instance, company_name, " +
  "lead_name, lead_email, from_name, from_email, to_name, to_email, " +
  "prospect_cc_name, prospect_cc_email, prospect_bcc_name, prospect_bcc_email, " +
  "sender_id, sender_name, sender_email, our_reply, lead_category, ai_categorized_lead_category, " +
  "reply_we_got, reply_status, created_at, categorized_at";

const SORTS: Record<string, { col: string; asc: boolean }> = {
  newest: { col: "created_at", asc: false },
  oldest: { col: "created_at", asc: true },
  recently_categorized: { col: "categorized_at", asc: false },
  name_az: { col: "lead_name", asc: true },
  company_az: { col: "company_name", asc: true },
};

let _archivedCol: boolean | null = null;
async function hasArchivedColumn(): Promise<boolean> {
  if (_archivedCol !== null) return _archivedCol;
  const { error } = await supabase.from("replies").select("id").eq("archived", false).limit(1);
  _archivedCol = !error;
  return _archivedCol;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const sp = req.nextUrl.searchParams;
    const clientTag = sp.get("client_tag") || null;
    const category = sp.get("category") || null;
    const aiCategory = sp.get("ai_category") || null;
    const search = (sp.get("search") || "").trim();
    const dateFrom = sp.get("date_from") || null;   // YYYY-MM-DD
    const dateTo = sp.get("date_to") || null;
    const sortKey = sp.get("sort") || "newest";
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(sp.get("limit")) || PAGE_SIZE));
    const offset = Math.max(0, Number(sp.get("offset")) || 0);
    const sort = SORTS[sortKey] || SORTS.newest;

    const allowed = session?.allowedClientTags ?? null;

    // NO count() — an exact/estimated count over the ~127k-row table blows the
    // Postgres statement timeout (8s+). We fetch limit+1 rows instead and infer
    // hasMore from the overflow; the data query alone is ~350ms.
    let q = supabase
      .from("replies")
      .select(SELECT)
      .order(sort.col, { ascending: sort.asc, nullsFirst: false })
      .range(offset, offset + limit); // limit+1 rows

    if (await hasArchivedColumn()) q = q.eq("archived", false); // active only
    // Per-user client scoping (enforced server-side regardless of UI filters).
    if (clientTag && (!allowed || allowed.includes(clientTag))) q = q.eq("client_tag", clientTag);
    else if (allowed && allowed.length) q = q.in("client_tag", allowed);
    if (category) q = q.eq("lead_category", category);
    if (aiCategory) q = q.eq("ai_categorized_lead_category", aiCategory);
    if (dateFrom) q = q.gte("created_at", `${dateFrom}T00:00:00Z`);
    if (dateTo) q = q.lte("created_at", `${dateTo}T23:59:59Z`);
    if (search) {
      q = q.or(
        `lead_email.ilike.%${search}%,company_name.ilike.%${search}%,lead_name.ilike.%${search}%,from_email.ilike.%${search}%,reply_we_got.ilike.%${search}%`,
      );
    }

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    // We asked for limit+1; if we got the extra row there's another page.
    const all = data || [];
    const hasMore = all.length > limit;
    const rows = hasMore ? all.slice(0, limit) : all;
    return NextResponse.json({
      rows,
      page: { limit, offset, returned: rows.length, total: null, hasMore },
    });
  } catch (error) {
    console.error("[api/data-view] GET failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
