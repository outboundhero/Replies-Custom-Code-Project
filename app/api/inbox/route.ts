import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import supabase from "@/lib/supabase";
import db from "@/lib/db";
import { getView, pickFirstCategory, type InboxView } from "@/lib/inbox-views";
import { getInboxCache, setInboxCache, getCacheVersion } from "@/lib/inbox-cache";

// Counts + leads can be slow on the big replies table.
export const maxDuration = 60;

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

// Cache TTLs — short enough that realtime UI updates make stale data invisible,
// long enough that repeat page loads inside the same session are instant.
const COUNTS_TTL_MS = 60 * 1000;       // 60s — counts shift slowly per category
const CLIENT_TAGS_TTL_MS = 5 * 60 * 1000; // 5min — tags barely change

const LEADS_SELECT =
  "id, workflow, lead_email, lead_name, company_name, client_tag, bison_instance, ai_categorized_lead_category, lead_category, reply_status, industry_audit, location_audit, created_at, reply_id";

/**
 * Mirror of LEAD_CATEGORIES in app/(dashboard)/inbox/page.tsx — keep in sync.
 * Used by the slow-path COUNT fallback only.
 */
const LEAD_CATEGORIES = [
  "Open Response", "Interested", "Meeting Set", "Not Interested", "Do Not Contact",
  "Out Of Office", "Wrong Person", "Lost", "Meeting-Ready Lead", "Follow Up",
  "Automated Reply", "Needs Review", "Change Of Target", "Not Interested (Send Reply)",
  "Unqualified (Cleaning)", "Closed Won", "Mailbox No Longer Active", "Referral Given",
  "Internally Forwarded",
];

/**
 * Apply a view's filter rules to a Supabase query builder. Both clauses hit the
 * precomputed `inbox_is_noise` flag + the exact-match AI-category index — no
 * leading-wildcard ILIKEs, so this is index-friendly (see sql/2026-07_inbox_is_noise.sql).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyView(q: any, view: InboxView | null): any {
  if (!view) return q;
  if (view.excludeNoise) q = q.eq("inbox_is_noise", false);
  if (view.aiCategoryAllowlist && view.aiCategoryAllowlist.length > 0) {
    q = q.in("ai_categorized_lead_category", view.aiCategoryAllowlist);
  }
  return q;
}

// ── Shared read helpers — used by mode=counts / leads / client_tags / bootstrap
// so every path shares identical scoping, filtering, and caching. ─────────────

async function resolveClientTags(allowed: string[] | null, fresh: boolean): Promise<string[]> {
  // Scoped users only ever see their allowed list — skip the distinct scan.
  if (allowed && allowed.length) return allowed.slice().sort();
  const cacheKey = `tags:v${getCacheVersion()}`;
  if (!fresh) {
    const hit = getInboxCache<{ tags: string[] }>(cacheKey, CLIENT_TAGS_TTL_MS);
    if (hit) return hit.tags;
  }
  // Canonical client list from Turso `client_tags` (tiny indexed table) instead
  // of scanning ~245k replies rows. Kept behind the 5-min cache.
  const r = await db.execute("SELECT tag FROM client_tags ORDER BY tag");
  const tags = r.rows.map((x) => String(x.tag)).filter(Boolean);
  setInboxCache(cacheKey, { tags });
  return tags;
}

async function computeCounts(args: {
  clientTag: string | null; allowed: string[] | null; workflow: string | null;
  search: string | null; view: InboxView | null; viewParam: string | null; fresh: boolean;
}): Promise<{ counts: Record<string, number>; total: number }> {
  const { clientTag, allowed, workflow, search, view, viewParam, fresh } = args;
  const cacheKey = `counts:v${getCacheVersion()}:${JSON.stringify({ clientTag, allowed, workflow, search, view: viewParam })}`;
  if (!fresh) {
    const hit = getInboxCache<{ counts: Record<string, number>; total: number }>(cacheKey, COUNTS_TTL_MS);
    if (hit) return hit;
  }

  // Negative buckets the active view hides from the sidebar.
  const hidden = new Set(view?.hiddenLeadCategories ?? []);

  // Fast path: one RPC call. Noise + AI-allowlist are index-backed params.
  const { data: rpcRows, error: rpcErr } = await supabase.rpc("inbox_category_counts", {
    p_client_tag: clientTag,
    p_allowed_tags: clientTag ? null : (allowed && allowed.length ? allowed : null),
    p_workflow: workflow,
    p_search: search,
    p_exclude_noise: !!view?.excludeNoise,
    p_ai_allowlist: view?.aiCategoryAllowlist ?? null,
  });

  if (!rpcErr && Array.isArray(rpcRows)) {
    const counts: Record<string, number> = {};
    let total = 0;
    for (const row of rpcRows as Array<{ lead_category: string; n: number }>) {
      if (hidden.has(row.lead_category)) continue;
      const n = Number(row.n) || 0;
      counts[row.lead_category] = n;
      total += n;
    }
    const payload = { counts, total };
    setInboxCache(cacheKey, payload);
    return payload;
  }

  // Slow-path fallback: per-category COUNT fan-out. Only if the RPC isn't
  // installed yet or errors. applyView hits the indexed inbox_is_noise +
  // exact AI-category match, not the old ILIKE chain.
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
      if (error) { console.error(`[inbox/counts:${label}]`, JSON.stringify(error)); return 0; }
      return count ?? 0;
    } catch (e) {
      console.error(`[inbox/counts:${label}] threw:`, e);
      return 0;
    }
  };

  const visibleCats = LEAD_CATEGORIES.filter((c) => !hidden.has(c));
  const categoryCounts = await Promise.all(
    visibleCats.map((cat) => runCount(`cat:${cat}`, baseQuery().eq("lead_category", cat))),
  );

  const counts: Record<string, number> = {};
  let total = 0;
  visibleCats.forEach((cat, i) => { counts[cat] = categoryCounts[i]; total += categoryCounts[i]; });

  const payload = { counts, total };
  setInboxCache(cacheKey, payload);
  return payload;
}

async function fetchLeads(args: {
  clientTag: string | null; allowed: string[] | null; category: string | null;
  workflow: string | null; search: string | null; view: InboxView | null;
  limit: number; offset: number;
}): Promise<{ replies: unknown[]; page: { limit: number; offset: number; returned: number; hasMore: boolean } }> {
  const { clientTag, allowed, category, workflow, search, view, limit, offset } = args;
  let q = supabase
    .from("replies")
    .select(LEADS_SELECT)
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
  const returned = rows?.length || 0;
  return { replies: rows || [], page: { limit, offset, returned, hasMore: returned === limit } };
}

export async function GET(req: NextRequest) {
  // Single session read (was requireAuth() + getSession() = two JWT verifies).
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const allowed = session?.allowedClientTags ?? null;

    const mode = req.nextUrl.searchParams.get("mode");
    const fresh = req.nextUrl.searchParams.get("fresh") === "1";
    const requestedClientTag = req.nextUrl.searchParams.get("client_tag");
    // Hard-enforce per-user client scoping. If the caller asks for a tag
    // they're not allowed to see, override to one of their allowed tags
    // (or one that matches none → empty results) — never expose the row.
    let clientTag = requestedClientTag;
    if (allowed && allowed.length) {
      if (clientTag && !allowed.includes(clientTag)) clientTag = allowed[0];
    }
    const category = req.nextUrl.searchParams.get("category");
    const workflow = req.nextUrl.searchParams.get("workflow");
    const search = req.nextUrl.searchParams.get("search");
    const viewParam = req.nextUrl.searchParams.get("view");
    const view = getView(viewParam);

    // Mode: client_tags — distinct client tags for the dropdown.
    if (mode === "client_tags") {
      return NextResponse.json({ tags: await resolveClientTags(allowed, fresh) });
    }

    // Mode: counts — all category counts in one RPC round trip (60s cache).
    if (mode === "counts") {
      return NextResponse.json(await computeCounts({ clientTag, allowed, workflow, search, view, viewParam, fresh }));
    }

    // Mode: bootstrap — everything the inbox needs to paint on open in ONE
    // response: counts + the first non-empty category's first page of leads +
    // the client-tags dropdown. Collapses the old counts→leads waterfall.
    if (mode === "bootstrap") {
      const [{ counts, total }, clientTags] = await Promise.all([
        computeCounts({ clientTag, allowed, workflow, search, view, viewParam, fresh }),
        resolveClientTags(allowed, fresh),
      ]);
      const firstCategory = pickFirstCategory(counts);
      let leads: unknown[] = [];
      let hasMore = false;
      if (firstCategory) {
        const r = await fetchLeads({
          clientTag, allowed, category: firstCategory, workflow, search, view,
          limit: DEFAULT_PAGE_SIZE, offset: 0,
        });
        leads = r.replies;
        hasMore = r.page.hasMore;
      }
      return NextResponse.json({ counts, total, firstCategory, leads, hasMore, clientTags });
    }

    // Default mode: fetch leads for a specific category, paginated.
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.nextUrl.searchParams.get("limit") || DEFAULT_PAGE_SIZE)));
    const offset = Math.max(0, Number(req.nextUrl.searchParams.get("offset") || 0));
    return NextResponse.json(
      await fetchLeads({ clientTag, allowed, category, workflow, search, view, limit, offset }),
    );
  } catch (error) {
    console.error("[api/inbox] GET failed:", error);
    return NextResponse.json({ error: "Failed to fetch inbox" }, { status: 500 });
  }
}
