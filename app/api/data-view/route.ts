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

// Column sorts for the click-a-header UI. `sort=<col>.<asc|desc>`.
// IMPORTANT: never pass a NULLS option that fights the index — a plain btree
// serves ASC NULLS LAST and (scanned backward) DESC NULLS FIRST. Forcing
// DESC NULLS LAST on created_at is what caused the original 8s timeout.
// categorized_at is the one exception: it's often null, so it has a dedicated
// DESC NULLS LAST partial index (sql/2026-07_data_view_indexes.sql).
const SORTABLE = new Set([
  "created_at", "categorized_at", "lead_name", "company_name",
  "lead_category", "ai_categorized_lead_category", "client_tag",
]);

// Advanced filter builder (Airtable-style): `filters` = JSON [{field, op, value}]
// combined with AND. Whitelisted fields/ops only; text fields are trgm-indexed.
const TEXT_FIELDS = new Set(["lead_name", "lead_email", "from_email", "company_name", "reply_we_got"]);
const ENUM_FIELDS = new Set(["lead_category", "ai_categorized_lead_category", "client_tag", "workflow", "bison_instance"]);
interface Cond { field: string; op: string; value: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyConds(q: any, conds: Cond[]): any {
  for (const c of conds) {
    const v = String(c.value ?? "").trim();
    if (!v) continue;
    if (TEXT_FIELDS.has(c.field)) {
      if (c.op === "contains") q = q.ilike(c.field, `%${v}%`);
      else if (c.op === "not_contains") q = q.not(c.field, "ilike", `%${v}%`);
    } else if (ENUM_FIELDS.has(c.field)) {
      if (c.op === "is") q = q.eq(c.field, v);
      else if (c.op === "is_not") q = q.neq(c.field, v);
    } else if (c.field === "created_at") {
      if (c.op === "after") q = q.gte("created_at", `${v}T00:00:00Z`);
      else if (c.op === "before") q = q.lte("created_at", `${v}T23:59:59Z`);
    }
  }
  return q;
}

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
    const [sortColRaw, sortDirRaw] = (sp.get("sort") || "created_at.desc").split(".");
    const sortCol = SORTABLE.has(sortColRaw) ? sortColRaw : "created_at";
    const sortAsc = sortDirRaw === "asc";
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(sp.get("limit")) || PAGE_SIZE));
    const offset = Math.max(0, Number(sp.get("offset")) || 0);

    const allowed = session?.allowedClientTags ?? null;

    // NO count() — an exact/estimated count over the ~127k-row table blows the
    // Postgres statement timeout (8s+). We fetch limit+1 rows instead and infer
    // hasMore from the overflow; the data query alone is ~250ms.
    const orderOpts: { ascending: boolean; nullsFirst?: boolean } = { ascending: sortAsc };
    // categorized_at rides its dedicated (DESC NULLS LAST) partial index:
    // desc = forward scan (NULLS LAST), asc = backward scan (NULLS FIRST).
    if (sortCol === "categorized_at") orderOpts.nullsFirst = sortAsc;
    let q = supabase
      .from("replies")
      .select(SELECT)
      .order(sortCol, orderOpts)
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
    // Advanced multi-condition filters (AND-combined).
    const filtersRaw = sp.get("filters");
    if (filtersRaw) {
      try {
        const conds = JSON.parse(filtersRaw) as Cond[];
        if (Array.isArray(conds)) q = applyConds(q, conds.slice(0, 10));
      } catch { /* malformed filters param — ignore */ }
    }

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    // We asked for limit+1; if we got the extra row there's another page.
    const all = data || [];
    const hasMore = all.length > limit;
    // Trim long reply bodies for the grid — full text is fetched per-record by
    // the panel (/api/inbox/[id]). Cuts the JSON payload dramatically.
    const rows = (hasMore ? all.slice(0, limit) : all).map((raw) => {
      // Supabase's dynamic-select typing lands on GenericStringError — cast through unknown.
      const r = raw as unknown as Record<string, unknown>;
      const body = r.reply_we_got;
      if (typeof body === "string" && body.length > 600) {
        return { ...r, reply_we_got: body.slice(0, 600) + "…" };
      }
      return r;
    });
    return NextResponse.json({
      rows,
      page: { limit, offset, returned: rows.length, total: null, hasMore },
    });
  } catch (error) {
    console.error("[api/data-view] GET failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
