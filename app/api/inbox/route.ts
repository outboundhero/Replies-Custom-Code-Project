import { NextRequest, NextResponse } from "next/server";
import { requireAuth, getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";
import { getView, type InboxView } from "@/lib/inbox-views";
import { getInboxCache, setInboxCache, getCacheVersion } from "@/lib/inbox-cache";

// Counts + leads can be slow on the big replies table.
export const maxDuration = 60;

const BATCH_SIZE = 1000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

// Cache TTLs — short enough that realtime UI updates make stale data invisible,
// long enough that repeat page loads inside the same session are instant.
const COUNTS_TTL_MS = 60 * 1000;       // 60s — counts shift slowly per category
const CLIENT_TAGS_TTL_MS = 5 * 60 * 1000; // 5min — tags barely change

/**
 * Mirror of LEAD_CATEGORIES in app/(dashboard)/inbox/page.tsx — keep in sync.
 * Used for parallel COUNT queries instead of fetching every row to count
 * categories in JS (which got progressively slower as the table grew).
 */
const LEAD_CATEGORIES = [
  "Open Response", "Interested", "Meeting Set", "Not Interested", "Do Not Contact",
  "Out Of Office", "Wrong Person", "Lost", "Meeting-Ready Lead", "Follow Up",
  "Automated Reply", "Needs Review", "Change Of Target", "Not Interested (Send Reply)",
  "Unqualified (Cleaning)", "Closed Won", "Mailbox No Longer Active", "Referral Given",
  "Internally Forwarded",
];

/** Fetch ALL rows for a lightweight column query by paginating through batches */
async function fetchAllRows<T>(
  buildQuery: (from: number, to: number) => ReturnType<typeof supabase.from>,
): Promise<T[]> {
  const allRows: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await (buildQuery(offset, offset + BATCH_SIZE - 1) as any);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }
  return allRows;
}

/** Apply a view's filter rules to a Supabase query builder */
function applyView(q: any, view: InboxView | null): any {
  if (!view) return q;

  // "Does not contain" filters — use NOT ILIKE
  for (const term of view.replyExcludes || []) {
    q = q.not("reply_we_got", "ilike", `%${term}%`);
  }
  for (const term of view.leadEmailExcludes || []) {
    q = q.not("lead_email", "ilike", `%${term}%`);
  }
  for (const term of view.toEmailExcludes || []) {
    q = q.not("to_email", "ilike", `%${term}%`);
  }
  for (const term of view.emailSubjectExcludes || []) {
    q = q.not("email_subject", "ilike", `%${term}%`);
  }

  // AI category OR group — must match at least one
  if (view.aiCategoryAny && view.aiCategoryAny.length > 0) {
    const orParts = view.aiCategoryAny.map((rule) => {
      if (rule.equals !== undefined) return `ai_categorized_lead_category.eq.${rule.equals}`;
      if (rule.contains !== undefined) return `ai_categorized_lead_category.ilike.%${rule.contains}%`;
      return null;
    }).filter(Boolean).join(",");
    if (orParts) q = q.or(orParts);
  }

  return q;
}

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const session = await getSession();
    const allowed = session?.allowedClientTags ?? null;

    const mode = req.nextUrl.searchParams.get("mode");
    const fresh = req.nextUrl.searchParams.get("fresh") === "1";
    const requestedClientTag = req.nextUrl.searchParams.get("client_tag");
    // Hard-enforce per-user client scoping. If the caller asks for a tag
    // they're not allowed to see, override to one of their allowed tags
    // (or one that matches none → empty results) — never expose the row.
    let clientTag = requestedClientTag;
    if (allowed && allowed.length) {
      if (clientTag && !allowed.includes(clientTag)) {
        // Asked for a tag outside their scope → force the first allowed
        // tag so nothing else leaks.
        clientTag = allowed[0];
      }
    }
    const category = req.nextUrl.searchParams.get("category");
    const workflow = req.nextUrl.searchParams.get("workflow");
    const search = req.nextUrl.searchParams.get("search");
    const view = getView(req.nextUrl.searchParams.get("view"));

    // Mode: client_tags — return distinct client tags
    if (mode === "client_tags") {
      // Scoped users only see their allowed list; skip the (slow) full
      // distinct-scan entirely for them.
      if (allowed && allowed.length) {
        return NextResponse.json({ tags: allowed.slice().sort() });
      }
      // Cached for 5 minutes — distinct client tags barely change.
      const cacheKey = `tags:v${getCacheVersion()}`;
      if (!fresh) {
        const hit = getInboxCache<{ tags: string[] }>(cacheKey, CLIENT_TAGS_TTL_MS);
        if (hit) return NextResponse.json(hit);
      }
      const data = await fetchAllRows<{ client_tag: string }>((from, to) => {
        let q = supabase.from("replies").select("client_tag").range(from, to);
        return q as any;
      });
      const tags = [...new Set(data.map((r) => r.client_tag).filter(Boolean))].sort();
      const payload = { tags };
      setInboxCache(cacheKey, payload);
      return NextResponse.json(payload);
    }

    // Mode: counts — single Postgres function call returns all category
    // counts in one round trip with one query plan. Replaces 20 parallel
    // HEAD count queries, each of which forced the planner to re-evaluate
    // the 32-clause cherry view NOT ILIKE chain.
    //
    // Falls back to the legacy 20-query path if the RPC isn't installed
    // yet (so a fresh deploy doesn't break before the SQL is applied).
    //
    // Cached for 60s; mutations + new replies bump the version counter.
    if (mode === "counts") {
      const viewParam = req.nextUrl.searchParams.get("view");
      const cacheKey = `counts:v${getCacheVersion()}:${JSON.stringify({
        clientTag,
        allowed,
        workflow,
        search,
        view: viewParam,
      })}`;
      if (!fresh) {
        const hit = getInboxCache<{ counts: Record<string, number>; total: number }>(cacheKey, COUNTS_TTL_MS);
        if (hit) return NextResponse.json(hit);
      }

      // Fast path: one RPC call.
      const { data: rpcRows, error: rpcErr } = await supabase.rpc("inbox_category_counts", {
        p_client_tag: clientTag,
        p_allowed_tags: clientTag ? null : (allowed && allowed.length ? allowed : null),
        p_workflow: workflow,
        p_search: search,
        p_view: viewParam,
      });

      if (!rpcErr && Array.isArray(rpcRows)) {
        const counts: Record<string, number> = {};
        LEAD_CATEGORIES.forEach((cat) => { counts[cat] = 0; });
        let total = 0;
        for (const row of rpcRows as Array<{ lead_category: string; n: number }>) {
          const n = Number(row.n) || 0;
          if (row.lead_category in counts) counts[row.lead_category] = n;
          total += n;
        }
        const payload = { counts, total };
        setInboxCache(cacheKey, payload);
        return NextResponse.json(payload);
      }

      // Slow-path fallback: legacy 20-query fan-out. Used only if the RPC
      // isn't installed (one-time, until the SQL is applied) or if it errors.
      if (rpcErr) console.warn("[inbox/counts] RPC failed, falling back:", rpcErr.message);

      const baseQuery = () => {
        let q = supabase.from("replies").select("id", { count: "estimated", head: true });
        if (clientTag) q = q.eq("client_tag", clientTag);
        else if (allowed && allowed.length) q = q.in("client_tag", allowed);
        if (workflow) q = q.eq("workflow", workflow);
        if (search) q = q.or(`lead_email.ilike.%${search}%,company_name.ilike.%${search}%,lead_name.ilike.%${search}%`);
        q = applyView(q, view);
        return q;
      };

      const runCount = async (label: string, q: ReturnType<typeof baseQuery>): Promise<number> => {
        try {
          const { count, error } = await q;
          if (error) {
            console.error(`[inbox/counts:${label}]`, JSON.stringify(error));
            return 0;
          }
          return count ?? 0;
        } catch (e) {
          console.error(`[inbox/counts:${label}] threw:`, e);
          return 0;
        }
      };

      const [totalCount, ...categoryCounts] = await Promise.all([
        runCount("total", baseQuery()),
        ...LEAD_CATEGORIES.map((cat) =>
          runCount(`cat:${cat}`, baseQuery().eq("lead_category", cat))
        ),
      ]);

      const counts: Record<string, number> = {};
      LEAD_CATEGORIES.forEach((cat, i) => {
        counts[cat] = categoryCounts[i];
      });

      const payload = { counts, total: totalCount };
      setInboxCache(cacheKey, payload);
      return NextResponse.json(payload);
    }

    // Default mode: fetch leads for a specific category, paginated.
    // Old code fetched ALL rows for the category — fine when there were
    // a few hundred, painful at 50k+. Now: 100 rows per request, with
    // offset for "load more".
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.nextUrl.searchParams.get("limit") || DEFAULT_PAGE_SIZE)));
    const offset = Math.max(0, Number(req.nextUrl.searchParams.get("offset") || 0));

    let q = supabase
      .from("replies")
      .select("id, workflow, lead_email, lead_name, company_name, client_tag, bison_instance, ai_categorized_lead_category, lead_category, reply_status, industry_audit, location_audit, created_at, reply_id")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (clientTag) q = q.eq("client_tag", clientTag);
    else if (allowed && allowed.length) q = q.in("client_tag", allowed);
    if (category) q = q.eq("lead_category", category);
    if (workflow) q = q.eq("workflow", workflow);
    if (search) q = q.or(`lead_email.ilike.%${search}%,company_name.ilike.%${search}%,lead_name.ilike.%${search}%`);
    q = applyView(q, view) as typeof q;
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    return NextResponse.json({
      replies: rows || [],
      page: { limit, offset, returned: rows?.length || 0, hasMore: (rows?.length || 0) === limit },
    });
  } catch (error) {
    console.error("[api/inbox] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch inbox" }, { status: 500 });
  }
}
